#include "voxel/grid.h"
#include "voxel/voxelize.h"
#include <algorithm>
#include <bit>
#include <charconv>
#include <chrono>
#include <cmath>
#include <gpu/compute.h>
#include <iostream>
#include <numeric>
#include <pipeline/runner.h>

using namespace splat_transform;
namespace {
splat::Splat feature_splats(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& matrix, unsigned degree) {
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
        uint32_t selected = 0;
        bool large_tests = false;
        for (int i = 1; i < argc; ++i) {
            const std::string_view argument(argv[i]);
            if (argument == "--large") {
                large_tests = true;
            } else if (argument == "--gpu" && i + 1 < argc) {
                const std::string_view value(argv[++i]);
                const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), selected);
                if (error != std::errc {} || end != value.data() + value.size()) {
                    throw std::runtime_error("Expected a nonnegative Vulkan device index after --gpu");
                }
            } else {
                throw std::runtime_error("Usage: splat_transform_gpu_tests [--large] [--gpu INDEX]");
            }
        }
        gpu::select_device(selected);
        const auto devices = gpu::enumerate_devices();
        if (devices.empty()) {
            throw std::runtime_error("GPU tests require a Vulkan compute device");
        }
        {
            splat::Splat points(512, 0);
            for (size_t i = 0; i < points.size(); ++i) {
                auto& g = points.gaussians[i];
                g.mean = { float(i) * 1.6f + 0.05f, 0.05f, 0.05f };
                g.scale = { 0.02f, 0.02f, 0.02f };
                g.rotation = Eigen::Quaternionf::Identity();
                g.opacity = 0.9f;
            }
            const auto grid = voxel::voxelize(voxel::prepare(points), Eigen::AlignedBox3f(Eigen::Vector3f::Zero(), Eigen::Vector3f(512 * 1.6f, 0.4f, 0.4f)), 0.1f, 0.2f);
            if (grid.voxel_count() != points.size()) {
                throw std::runtime_error("Scene-wide voxel dispatch changed isolated Gaussian occupancy");
            }
            for (size_t i = 0; i < points.size(); ++i) {
                if (!grid.get({ int(i * 16), 0, 0 })) {
                    throw std::runtime_error("Scene-wide voxel dispatch lost a batch after the old 256-batch boundary");
                }
            }
        }
        for (unsigned degree : { 1u, 2u, 3u }) {
            const auto columns = splat::SH_COUNTS[degree];
            Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> points(257, columns), centroids(129, columns);
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
            Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> points(ROWS, COLUMNS), centroids(CENTROIDS, COLUMNS);
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
        if (large_tests) {
            {
                std::vector<gpu::Gaussian> large(65535 * 128 + 1);
                large.back() = gaussians.front();
                const auto result = gpu::candidates(large, { 0, 0, 0 }, 1, { 2, 2, 2 });
                if (result.counts[0] != 1 || result.indices.size() != 1 || result.indices[0] != large.size() - 1) {
                    throw std::runtime_error("Vulkan multidimensional dispatch lost candidates");
                }
                std::cout << "Large candidate dispatch passed: " << large.size() << " gaussians\n";

                auto weak = gaussians.front();
                weak.values[3] = 0.06f;
                const std::array reference_points { weak, weak };
                const std::array<uint32_t, 2> reference_indices { 0, 1 };
                gpu::VoxelBatch batch { 0, 2, 1, 1, 1, 0.45f, 0.45f, 0.45f };
                const auto expected = gpu::voxelize(reference_points, reference_indices, std::span(&batch, 1), 0.1f, 0.1f, 1);
                batch.index_count = 1;
                const auto single = gpu::voxelize(reference_points, reference_indices, std::span(&batch, 1), 0.1f, 0.1f, 1);
                if (!(expected[0] & 1) || single[0] || single[1]) {
                    throw std::runtime_error("Density fixture must cross the cutoff only after both contributions");
                }
                large[large.size() - 2] = large.back() = weak;
                const std::array<uint32_t, 2> remapped { uint32_t(large.size() - 2), uint32_t(large.size() - 1) };
                batch.index_count = 2;
                if (gpu::voxelize(large, remapped, std::span(&batch, 1), 0.1f, 0.1f, 1) != expected) {
                    throw std::runtime_error("Voxel input compaction lost global Gaussian indices");
                }
                // More than 128 MiB of packed Gaussian candidates, with the
                // two nonzero contributions on opposite sides of the split.
                std::vector<uint32_t> dense_indices(2 * 1024 * 1024 + 1);
                dense_indices.front() = remapped[0];
                dense_indices.back() = remapped[1];
                batch.index_count = uint32_t(dense_indices.size());
                if (gpu::voxelize(large, dense_indices, std::span(&batch, 1), 0.1f, 0.1f, 1) != expected) {
                    throw std::runtime_error("Voxel density changed across candidate chunks");
                }
                std::cout << "Large voxel compaction and density accumulation passed\n";
            }
            gpu::release_device();
            {
                const std::array<uint32_t, 1> indices { 0 };
                const gpu::VoxelBatch batch { 0, 1, 1, 1, 1, 0.45f, 0.45f, 0.45f };
                const auto expected = gpu::voxelize(gaussians, indices, std::span(&batch, 1), 0.1f, 0.1f, 1);
                std::vector<gpu::VoxelBatch> batches(65536, batch);
                const auto masks = gpu::voxelize(gaussians, indices, batches, 0.1f, 0.1f, 1);
                for (size_t i = 0; i < batches.size(); ++i) {
                    if (masks[i * 2] != expected[0] || masks[i * 2 + 1] != expected[1]) {
                        throw std::runtime_error("Voxel Z dispatch split lost a batch");
                    }
                }
                gpu::VoxelBatch padded { 0, 0, 65535, 1, 1, 0, 0, 0 };
                const auto empty = gpu::voxelize({}, {}, std::span(&padded, 1), 1, 0, 65536);
                if (empty.size() != 65536 * 2 || empty[65535 * 2] || empty.back() ||
                    std::ranges::any_of(empty.begin(), empty.end() - 2, [](uint32_t word) { return word != UINT32_MAX; })) {
                    throw std::runtime_error("Voxel X dispatch split lost its block offset or padding");
                }
                std::cout << "Large voxel X/Z workgroup splits passed\n";
            }
            gpu::release_device();
            {
                // The scatter output is 256 MiB even though both inputs fit
                // within Lavapipe's 128 MiB storage-buffer range.
                std::vector<gpu::Gaussian> overlapping(64);
                for (auto& gaussian : overlapping) {
                    gaussian.values = { 64, 64, 32, 1, 1, 0, 0, 0, 1, 1, 1, 64, 64, 32, 0, 0 };
                }
                const auto result = gpu::candidates(overlapping, { 0, 0, 0 }, 1, { 128, 128, 64 });
                if (result.indices.size() != 64 * 128 * 128 * 64) {
                    throw std::runtime_error("Chunked candidate scatter lost overlapping Gaussians");
                }
                for (size_t bin = 0; bin < result.counts.size(); ++bin) {
                    if (result.counts[bin] != 64 || result.offsets[bin] != bin * 64) {
                        throw std::runtime_error("Chunked candidate scatter changed bin offsets");
                    }
                    uint64_t seen = 0;
                    for (size_t i = result.offsets[bin]; i < size_t(result.offsets[bin]) + 64; ++i) {
                        if (result.indices[i] >= 64) {
                            throw std::runtime_error("Chunked candidate scatter returned an invalid index");
                        }
                        seen |= uint64_t(1) << result.indices[i];
                    }
                    if (seen != UINT64_MAX) {
                        throw std::runtime_error("Chunked candidate scatter duplicated or lost an index");
                    }
                }
                std::cout << "Large candidate scatter passed: 256 MiB of indices\n";
            }
            gpu::release_device();
            {
                gpu::Gaussian boundary;
                boundary.values = { 0.5f, 8192, 0.5f, 1, 1, 0, 0, 0, 1, 1, 1, 0.1f, 0.1f, 0.1f, 0, 0 };
                const auto result = gpu::candidates(std::span(&boundary, 1), { 0, 0, 0 }, 1, { 4096, 8193, 1 });
                const size_t first = 8191 * 4096, second = 8192 * 4096;
                if (result.indices != std::vector<uint32_t> { 0, 0 } || result.counts[first] != 1 || result.counts[second] != 1 ||
                    result.offsets[first] != 0 || result.offsets[second] != 1 || std::accumulate(result.counts.begin(), result.counts.end(), uint64_t(0)) != 2) {
                    throw std::runtime_error("Candidate bin window lost a boundary overlap");
                }
                std::cout << "Large candidate bin window passed\n";
            }
            gpu::release_device();
            {
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
            gpu::release_device();
            {
                // More than 128 MiB of dense grid, with occupancy crossing a
                // tile seam and the outer grid faces. Build an independent
                // sparse oracle instead of scanning a billion cells on CPU.
                const voxel::Point size { 1024, 1024, 1028 };
                const std::array points { voxel::Point { 0, 0, 0 }, voxel::Point { 1023, 1023, 1027 }, voxel::Point { 511, 511, 515 } };
                voxel::Grid input(size), expected(size);
                for (const auto point : points) {
                    input.set(point);
                    for (int z = -1; z <= 1; ++z) {
                        for (int y = -1; y <= 1; ++y) {
                            for (int x = -1; x <= 1; ++x) {
                                expected.set({ point[0] + x, point[1] + y, point[2] + z });
                            }
                        }
                    }
                }
                std::vector<uint32_t> packed;
                for (auto index : input.active_blocks()) {
                    const auto mask = input.mask(index);
                    packed.insert(packed.end(), { index, uint32_t(mask), uint32_t(mask >> 32) });
                }
                const auto masks = gpu::dilate_blocks(packed, { 1024, 1024, 1028 }, { 1, 1, 1 });
                uint64_t occupied = 0;
                for (auto mask : masks) {
                    occupied += std::popcount(mask);
                }
                if (occupied != expected.voxel_count()) {
                    throw std::runtime_error("Tiled dilation changed occupancy at a seam");
                }
                for (auto index : expected.active_blocks()) {
                    if ((uint64_t(masks[size_t(index) * 2]) | uint64_t(masks[size_t(index) * 2 + 1]) << 32) != expected.mask(index)) {
                        throw std::runtime_error("Tiled dilation lost a halo or clipped a grid face");
                    }
                }
                std::cout << "Large tiled dilation and halo boundaries passed\n";
            }
            gpu::release_device();
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
        const Eigen::AlignedBox3f box(Eigen::Vector3f::Zero(), Eigen::Vector3f::Constant(1.6f));
        const auto grid = voxel::voxelize(prepared, box, 0.1, 0.1);
        if (!grid.get({ 8, 8, 8 }) || grid.get({ 0, 0, 0 })) {
            throw std::runtime_error("Vulkan voxel occupancy differs");
        }
        const auto empty = voxel::voxelize(prepared, box, 0.1, 1);
        if (empty.voxel_count()) {
            throw std::runtime_error("An empty GPU result must stay empty");
        }
        const auto directory = std::filesystem::temp_directory_path() / ("splat-voxel-links-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        struct Cleanup {
            std::filesystem::path path;
            ~Cleanup() {
                std::error_code error;
                std::filesystem::remove_all(path, error);
            }
        } cleanup { directory };
        std::filesystem::create_directories(directory);
        io::write_splat(directory / "source.esz", source);
        const auto path = [&](const char* relative) { return io::path_utf8(directory / relative); };
        using io::Json;
        pipeline::run({ { "version", 1 }, { "gpu", selected }, { "tasks", Json::array({ { { "type", "Read" }, { "config", { { "inputs", { path("source.esz") } }, { "output", "source" } } } }, { { "type", "AutoChunkLod" }, { "config", { { "input", "source" }, { "output", "lod" }, { "type", "esz" }, { "levels", Json::array({ { { "precision", 1 }, { "scaleBoost", 1 } } }) } } } }, { { "type", "Write" }, { "config", { { "input", "lod" }, { "output", path("scene/lod") } } } }, { { "type", "ExtractLodLevel" }, { "config", { { "input", "lod" }, { "output", "level" }, { "level", 0 } } } }, { { "type", "Voxel" }, { "config", { { "input", "level" }, { "output", path("scene/collision") }, { "filterCluster", false }, { "voxelResolution", 0.1 } } }, { "release", { "level" } } }, { { "type", "Voxel" }, { "config", { { "input", "source" }, { "output", path("scene/lod/voxel") }, { "filterCluster", false }, { "voxelResolution", 0.1 } } }, { "release", { "source" } } }, { { "type", "Write" }, { "config", { { "input", "lod" }, { "output", path("mirror/lod") } } }, { "release", { "lod" } } } }) } });
        const auto first = io::read_json(directory / "scene/lod/lod-meta.json");
        const auto second = io::read_json(directory / "mirror/lod/lod-meta.json");
        if (first.at("voxels") != Json::array({ "../collision/voxel-meta.json", "voxel/voxel-meta.json" }) ||
            second.at("voxels") != Json::array({ "../../scene/collision/voxel-meta.json", "../../scene/lod/voxel/voxel-meta.json" })) {
            throw std::runtime_error("GPU voxel output association or relative paths differ");
        }
        for (const auto& name : first.at("voxels")) {
            const auto metadata = directory / "scene/lod" / io::utf8_path(name.get<std::string>());
            const auto voxel_meta = io::read_json(metadata);
            for (const auto& file : voxel_meta.at("files")) {
                if (!std::filesystem::is_regular_file(metadata.parent_path() / io::utf8_path(file.get<std::string>()))) {
                    throw std::runtime_error("LOD voxel link points to missing voxel data");
                }
            }
        }
        gpu::release_device();
        std::cout << "Vulkan scalar-oracle, candidate, dilation, and allocation reuse tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        gpu::release_device();
        return 1;
    }
}
