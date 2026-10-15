#include "voxel/grid.h"
#include "voxel/voxelize.h"
#include <algorithm>
#include <cmath>
#include <gpu/compute.h>
#include <iostream>

using namespace splat_transform;
namespace {
splat::Splat feature_splats(const spatial::FeatureMatrix& matrix, unsigned degree) {
    splat::Splat result(static_cast<size_t>(matrix.rows()), degree);
    const auto coefficients = result.sh_count() / 3;
    for (size_t row = 0; row < result.size(); ++row) {
        for (size_t channel = 0; channel < 3; ++channel) {
            for (size_t coefficient = 0; coefficient < coefficients; ++coefficient) {
                result.gaussians[row].sh[3 + coefficient * 3 + channel] = matrix(row, channel * coefficients + coefficient);
            }
        }
    }
    return result;
}
voxel::Grid reference_dilation(const voxel::Grid& grid, voxel::Point radius) {
    voxel::Grid result(grid.size);
    for (int z = 0; z < grid.size[2]; ++z) {
        for (int y = 0; y < grid.size[1]; ++y) {
            for (int x = 0; x < grid.size[0]; ++x) {
                if (grid.get({ x, y, z })) {
                    for (int dz = -radius[2]; dz <= radius[2]; ++dz) {
                        for (int dy = -radius[1]; dy <= radius[1]; ++dy) {
                            for (int dx = -radius[0]; dx <= radius[0]; ++dx) {
                                result.set({ x + dx, y + dy, z + dz });
                            }
                        }
                    }
                }
            }
        }
    }
    return result;
}
} // namespace
int main(int argc, char** argv) {
    try {
        gpu::select_device(0);
        const auto devices = gpu::enumerate_devices();
        if (devices.empty()) {
            throw std::runtime_error("GPU tests require a Vulkan compute device");
        }
        for (unsigned degree : { 1u, 2u, 3u }) {
            const auto columns = splat::SH_COUNTS[degree];
            spatial::FeatureMatrix points(257, columns), centroids(129, columns);
            for (size_t c = 0; c < columns; ++c) {
                for (size_t k = 0; k < 129; ++k) {
                    centroids(k, c) = float(std::sin((k + 1) * (c + 3) * 0.173));
                }
                for (size_t row = 0; row < 257; ++row) {
                    points(row, c) = centroids(row % 129, c) + float(std::cos(row + c) * 0.003);
                }
            }
            const auto input = feature_splats(points, degree);
            gpu::ClusterSession session(spatial::FeatureView(input), static_cast<size_t>(centroids.rows()));
            const auto actual = session.assign(centroids);
            for (size_t row = 0; row < actual.size(); ++row) {
                double best = INFINITY;
                uint32_t expected = 0;
                for (uint32_t k = 0; k < 129; ++k) {
                    double distance = 0;
                    for (size_t c = 0; c < columns; ++c) {
                        const double delta = double(points(row, c)) - centroids(k, c);
                        distance += delta * delta;
                    }
                    if (distance < best) {
                        best = distance;
                        expected = k;
                    }
                }
                if (actual[row] != expected) {
                    double distance = 0;
                    for (size_t c = 0; c < columns; ++c) {
                        const double delta = double(points(row, c)) - centroids(actual[row], c);
                        distance += delta * delta;
                    }
                    if (distance - best > 2e-6 * columns) {
                        throw std::runtime_error("Vulkan clustering differs from scalar oracle: columns=" + std::to_string(columns) + " row=" + std::to_string(row) + " excess=" + std::to_string(distance - best));
                    }
                }
            }
        }
        {
            constexpr size_t ROWS = 200003, COLUMNS = 45, CENTROIDS = 129;
            spatial::FeatureMatrix points(ROWS, COLUMNS), centroids(CENTROIDS, COLUMNS);
            for (size_t c = 0; c < COLUMNS; ++c) {
                for (size_t k = 0; k < CENTROIDS; ++k) {
                    centroids(k, c) = float(std::sin((k + 1) * (c + 3) * 0.173));
                }
                for (size_t row = 0; row < ROWS; ++row) {
                    points(row, c) = centroids(row % CENTROIDS, c);
                }
            }
            {
                const auto input = feature_splats(points, 3);
                gpu::ClusterSession session(spatial::FeatureView(input), CENTROIDS);
                auto rotating = centroids;
                for (size_t iteration = 0; iteration < 3; ++iteration) {
                    const auto labels = session.assign(rotating);
                    for (size_t row = 0; row < ROWS; ++row) {
                        if (labels[row] != (row % CENTROIDS + CENTROIDS - iteration) % CENTROIDS) {
                            throw std::runtime_error("Clustering lost a batch, tail, or centroid update");
                        }
                    }
                    const Eigen::RowVectorXf first = rotating.row(0);
                    for (size_t row = 1; row < CENTROIDS; ++row) {
                        rotating.row(row - 1) = rotating.row(row);
                    }
                    rotating.row(CENTROIDS - 1) = first;
                }
            }
        }
        std::vector<gpu::Gaussian> gaussians(2);
        gaussians[0].values = { 0.5f, 0.5f, 0.5f, 1, 1, 0, 0, 0, 0.1f, 0.1f, 0.1f, 0.2f, 0.2f, 0.2f, 0, 0 };
        gaussians[1].values = { 1.0f, 1.0f, 1.0f, 1, 1, 0, 0, 0, 0.1f, 0.1f, 0.1f, 0.2f, 0.2f, 0.2f, 0, 0 };
        const auto candidates = gpu::candidates(gaussians, { 0, 0, 0 }, 1, { 2, 2, 2 });
        if (candidates.counts[0] != 2 || candidates.indices.size() != 9) {
            throw std::runtime_error("Vulkan candidate count/scatter mismatch");
        }
        for (size_t i = 1; i < 8; ++i) {
            if (candidates.counts[i] != 1 || candidates.indices[candidates.offsets[i]] != 1) {
                throw std::runtime_error("Vulkan candidate range mismatch");
            }
        }
        if (argc > 1 && std::string_view(argv[1]) == "--large") {
            {
                std::vector<gpu::Gaussian> large(65535 * 128 + 1);
                large.back() = gaussians.front();
                const auto result = gpu::candidates(large, { 0, 0, 0 }, 1, { 2, 2, 2 });
                if (result.counts[0] != 1 || result.indices.size() != 1 || result.indices[0] != large.size() - 1) {
                    throw std::runtime_error("Vulkan multidimensional dispatch lost candidates");
                }
                std::cout << "Large candidate dispatch passed: " << large.size() << " gaussians\n";
            }
            gpu::release_device();
            // Cross the 65535-workgroup X limit in expand, dilate, and compact.
            constexpr uint32_t BLOCKS = 1024 * 1024 * 512 / 64;
            std::vector<uint32_t> packed(size_t(65535 * 128 + 1) * 3);
            packed[packed.size() - 3] = BLOCKS - 1;
            packed.back() = 0x80000000;
            const auto masks = gpu::dilate_blocks(packed, { 1024, 1024, 512 }, { 1, 0, 0 });
            if (masks.size() != size_t(BLOCKS) * 2 || masks.back() != 0xc0000000 ||
                std::ranges::any_of(masks.begin(), masks.end() - 1, [](uint32_t word) { return word != 0; })) {
                throw std::runtime_error("Vulkan multidimensional dispatch lost dilation blocks");
            }
            std::cout << "Large expand/dilate/compact dispatch passed: " << BLOCKS << " blocks\n";
        }
        for (int dimension : { 12, 8, 16 }) {
            voxel::Grid grid({ dimension, dimension, dimension });
            grid.set({ 0, 0, 0 });
            grid.set({ 5, 5, 5 });
            const auto expected = reference_dilation(grid, { 1, 2, 1 });
            std::vector<uint32_t> packed;
            for (auto index : grid.active_blocks()) {
                const auto mask = grid.mask(index);
                packed.insert(packed.end(), { index, uint32_t(mask), uint32_t(mask >> 32) });
            }
            const auto actual = gpu::dilate_blocks(packed, { uint32_t(dimension), uint32_t(dimension), uint32_t(dimension) }, { 1, 2, 1 });
            for (uint32_t i = 0; i < grid.block_count(); ++i) {
                if ((uint64_t(actual[i * 2]) | (uint64_t(actual[i * 2 + 1]) << 32)) != expected.mask(i)) {
                    throw std::runtime_error("Vulkan expand/dilate/compact mismatch");
                }
            }
        }
        voxel::Grid single({ 12, 12, 12 });
        single.set({ 5, 5, 5 });
        if (voxel::dilate(single, { 1, 2, 1 }).voxel_count() != 45) {
            throw std::runtime_error("Box dilation changed its kernel");
        }
        splat::Splat source(1, 0);
        for (int a = 0; a < 3; ++a) {
            source.gaussians[0].attribute(a) = 0.8f;
            source.gaussians[0].attribute(splat::ScaleX + a) = 0.2f;
        }
        source.gaussians[0].attribute(splat::QuatW) = 1;
        source.gaussians[0].attribute(splat::Alpha) = 1;
        const auto prepared = voxel::prepare(source);
        const auto grid = voxel::voxelize(prepared, { { 0, 0, 0 }, { 1.6, 1.6, 1.6 } }, 0.1, 0.1);
        if (!grid.get({ 8, 8, 8 }) || grid.get({ 0, 0, 0 })) {
            throw std::runtime_error("Vulkan voxel occupancy differs");
        }
        const auto empty = voxel::voxelize(prepared, { { 0, 0, 0 }, { 1.6, 1.6, 1.6 } }, 0.1, 1);
        if (empty.voxel_count()) {
            throw std::runtime_error("An empty GPU result must stay empty");
        }
        gpu::release_device();
        std::cout << "Vulkan scalar-oracle, candidate, dilation, and allocation reuse tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        gpu::release_device();
        return 1;
    }
}
