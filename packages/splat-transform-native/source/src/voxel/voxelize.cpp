#include "voxelize.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <utility/logger.h>

namespace splat_transform::voxel {
namespace {
std::array<float, 3> extents(const splat::Splat& data, size_t index) {
    auto at = [&](size_t column) -> float { return data.gaussians[index].attribute(column); };
    const float opacity = at(splat::Alpha);
    if (opacity <= ALPHA_THRESHOLD) {
        return {};
    }
    float extend = 3;
    const float aware = std::sqrt(2 * std::log(opacity / ALPHA_THRESHOLD));
    if (std::isfinite(aware)) {
        extend = std::min(extend, aware);
    }
    const float sx = extend * at(splat::ScaleX), sy = extend * at(splat::ScaleY), sz = extend * at(splat::ScaleZ);
    const float x = at(splat::QuatX), y = at(splat::QuatY), z = at(splat::QuatZ), w = at(splat::QuatW);
    return {
        std::abs(1 - 2 * (y * y + z * z)) * sx + std::abs(2 * (x * y - w * z)) * sy + std::abs(2 * (x * z + w * y)) * sz,
        std::abs(2 * (x * y + w * z)) * sx + std::abs(1 - 2 * (x * x + z * z)) * sy + std::abs(2 * (y * z - w * x)) * sz,
        std::abs(2 * (x * z - w * y)) * sx + std::abs(2 * (y * z + w * x)) * sy + std::abs(1 - 2 * (x * x + y * y)) * sz
    };
}
float distance_squared(const gpu::Gaussian& gaussian, const std::array<float, 3>& difference) {
    const auto& g = gaussian.values;
    const float x = -float(g[5]), y = -float(g[6]), z = -float(g[7]), w = g[4];
    const float dx = difference[0], dy = difference[1], dz = difference[2];
    const float tx = 2 * (y * dz - z * dy), ty = 2 * (z * dx - x * dz), tz = 2 * (x * dy - y * dx);
    const float sx = (dx + w * tx + (y * tz - z * ty)) / std::max(float(g[8]), 1e-8f);
    const float sy = (dy + w * ty + (z * tx - x * tz)) / std::max(float(g[9]), 1e-8f);
    const float sz = (dz + w * tz + (x * ty - y * tx)) / std::max(float(g[10]), 1e-8f);
    return sx * sx + sy * sy + sz * sz;
}
struct Batch {
    Point origin;
    Point dimensions;
    std::vector<uint32_t> candidates;
};
std::vector<Batch> build_batches(const PreparedData& data, const Grid& grid, const splat::Bounds& bounds, float resolution) {
    Point count;
    for (int a = 0; a < 3; ++a) {
        count[a] = (grid.blocks[a] + 3) / 4;
    }
    const float batch_size = 16 * resolution;
    auto candidates = gpu::candidates(data.gaussians, { float(bounds.min[0]), float(bounds.min[1]), float(bounds.min[2]) }, float(batch_size),
        { uint32_t(count[0]), uint32_t(count[1]), uint32_t(count[2]) });
    std::vector<Batch> output;
    output.reserve(std::ranges::count_if(candidates.counts, [](auto size) { return size != 0; }));
    for (size_t key = 0; key < candidates.counts.size(); ++key) {
        if (!candidates.counts[key]) {
            continue;
        }
        const auto start = candidates.indices.begin() + candidates.offsets[key];
        std::vector<uint32_t> indices(start, start + candidates.counts[key]);
        std::ranges::sort(indices);
        Point origin { int(key % count[0]) * 4, int(key / count[0] % count[1]) * 4, int(key / (uint64_t(count[0]) * count[1])) * 4 };
        Point dimensions;
        for (int a = 0; a < 3; ++a) {
            dimensions[a] = std::min(4, grid.blocks[a] - origin[a]);
        }
        output.push_back({ origin, dimensions, std::move(indices) });
    }
    return output;
}
} // namespace

PreparedData prepare(const splat::Splat& data) {
    PreparedData output;
    output.gaussians.resize(data.size());
    output.scene.min.fill(INFINITY);
    output.scene.max.fill(-INFINITY);
    for (size_t i = 0; i < data.size(); ++i) {
        auto e = extents(data, i);
        const bool valid = std::all_of(e.begin(), e.end(), [](float v) { return std::isfinite(v); });
        if (!valid) {
            e.fill(0);
            ++output.invalid_extents;
        }
        auto& g = output.gaussians[i].values;
        for (int a = 0; a < 3; ++a) {
            g[a] = data.gaussians[i].attribute(splat::X + a);
            g[8 + a] = data.gaussians[i].attribute(splat::ScaleX + a);
            g[11 + a] = float(e[a]);
            if (valid) {
                output.scene.min[a] = std::min(output.scene.min[a], g[a] - e[a]);
                output.scene.max[a] = std::max(output.scene.max[a], g[a] + e[a]);
            }
        }
        g[3] = data.gaussians[i].attribute(splat::Alpha);
        g[4] = data.gaussians[i].attribute(splat::QuatW);
        for (int a = 0; a < 3; ++a) {
            g[5 + a] = data.gaussians[i].attribute(splat::QuatX + a);
        }
    }
    return output;
}
splat::Bounds align_bounds(splat::Bounds bounds, float resolution) {
    const float block_size = resolution * 4;
    for (int a = 0; a < 3; ++a) {
        bounds.min[a] = std::floor(bounds.min[a] / block_size) * block_size;
        bounds.max[a] = std::ceil(bounds.max[a] / block_size) * block_size;
    }
    return bounds;
}
Grid voxelize(const PreparedData& data, const splat::Bounds& bounds, float resolution, float cutoff) {
    Point dimensions;
    for (int a = 0; a < 3; ++a) {
        dimensions[a] = std::max(4, int(std::llround((bounds.max[a] - bounds.min[a]) / resolution)));
    }
    Grid output(dimensions);
    const auto batches = build_batches(data, output, bounds, resolution);
    for (size_t begin = 0; begin < batches.size(); begin += 256) {
        const size_t end = std::min(begin + 256, batches.size());
        std::vector<gpu::VoxelBatch> specs;
        std::vector<uint32_t> indices;
        for (size_t j = begin; j < end; ++j) {
            const auto& b = batches[j];
            specs.push_back({ uint32_t(indices.size()), uint32_t(b.candidates.size()), uint32_t(b.dimensions[0]), uint32_t(b.dimensions[1]), uint32_t(b.dimensions[2]),
                float(bounds.min[0] + b.origin[0] * 4 * resolution), float(bounds.min[1] + b.origin[1] * 4 * resolution), float(bounds.min[2] + b.origin[2] * 4 * resolution) });
            indices.insert(indices.end(), b.candidates.begin(), b.candidates.end());
        }
        const auto masks = gpu::voxelize(data.gaussians, indices, specs, resolution, cutoff, 64);
        for (size_t j = begin; j < end; ++j) {
            const auto& b = batches[j];
            for (int z = 0; z < b.dimensions[2]; ++z) {
                for (int y = 0; y < b.dimensions[1]; ++y) {
                    for (int x = 0; x < b.dimensions[0]; ++x) {
                        const size_t local = (j - begin) * 128 + 2 * (x + y * b.dimensions[0] + z * b.dimensions[0] * b.dimensions[1]);
                        output.set_mask(output.block_index({ b.origin[0] + x, b.origin[1] + y, b.origin[2] + z }), uint64_t(masks[local]) | (uint64_t(masks[local + 1]) << 32));
                    }
                }
            }
        }
    }
    return output;
}

splat::Bounds resolve_box(const splat::Splat& data, const io::Json& config) {
    splat::Bounds box { { -100, -100, -100 }, { 100, 100, 100 } };
    if (config.contains("box")) {
        box.min = config.at("box").at("minCorner").get<std::array<float, 3>>();
        box.max = config.at("box").at("maxCorner").get<std::array<float, 3>>();
    }
    const auto automatic = config.value("autoDenseBox", io::Json(true));
    if (automatic == false || data.size() == 0) {
        return box;
    }
    const auto options = automatic.is_object() ? automatic : io::Json::object();
    const auto center = splat::bounds(data), scene = prepare(data).scene;
    float inflation = 0, center_volume = 1, scene_volume = 1;
    for (int a = 0; a < 3; ++a) {
        const float c = std::max(0.0f, center.max[a] - center.min[a]), s = std::max(0.0f, scene.max[a] - scene.min[a]);
        inflation = std::max(inflation, s / std::max(c, 1e-6f));
        center_volume *= c;
        scene_volume *= s;
    }
    if (inflation < options.value("minimumAxisInflation", 1.5f) && scene_volume / std::max(center_volume, 1e-6f) < options.value("minimumVolumeInflation", 4.0f)) {
        return box;
    }
    auto dense = splat::dense_bounds(data, 1 - options.value("targetCenterKeepRatio", 0.98f));
    for (int a = 0; a < 3; ++a) {
        dense.min[a] = std::max(dense.min[a], box.min[a]);
        dense.max[a] = std::min(dense.max[a], box.max[a]);
        if (dense.min[a] >= dense.max[a]) {
            return box;
        }
    }
    size_t kept = 0;
    for (size_t i = 0; i < data.size(); ++i) {
        bool inside = true;
        for (int a = 0; a < 3; ++a) {
            inside &= data.gaussians[i].attribute(a) >= dense.min[a] && data.gaussians[i].attribute(a) <= dense.max[a];
        }
        kept += inside;
    }
    if (float(kept) / data.size() < options.value("minimumCenterKeepRatio", 0.95f)) {
        return box;
    }
    utility::logger().info("autoDenseBox: applied, kept ", kept, '/', data.size(), " centers (", utility::fixed(float(kept) / data.size() * 100), "%)");
    return dense;
}
splat::Splat filter_cluster(const splat::Splat& data, const io::Json& options, const splat::Bounds& box) {
    auto& logger = utility::logger();
    const float resolution = options.value("voxelResolution", 1.0f), cutoff = options.value("opacityCutoff", 0.999f), contribution = options.value("minContribution", 0.1f);
    if (!(resolution > 0) || cutoff < 0 || cutoff > 1 || contribution < 0) {
        throw std::runtime_error("Invalid filterCluster options");
    }
    if (!data.size()) {
        return data;
    }
    auto prepared = prepare(data);
    auto bounds = align_bounds(prepared.scene, resolution);
    std::array<float, 3> seed {};
    if (options.contains("seed")) {
        const auto& s = options.at("seed");
        seed = { s.at("x"), s.at("y"), s.at("z") };
    }
    for (int a = 0; a < 3; ++a) {
        bounds.min[a] = std::max(bounds.min[a], box.min[a]);
        bounds.max[a] = std::min(bounds.max[a], box.max[a]);
    }
    bounds = align_bounds(bounds, resolution);
    for (int a = 0; a < 3; ++a) {
        if (bounds.min[a] >= bounds.max[a]) {
            logger.warn("filterCluster: box does not overlap scene bounds, returning empty data");
            return data.select({});
        }
        if (bounds.max[a] - bounds.min[a] > 4096 * resolution) {
            const float half = 2048 * resolution, center = std::clamp(seed[a], bounds.min[a] + half, bounds.max[a] - half);
            bounds.min[a] = center - half;
            bounds.max[a] = center + half;
        }
    }
    const auto occupied = voxelize(prepared, bounds, resolution, cutoff);
    if (!occupied.voxel_count()) {
        logger.warn("filterCluster: no occupied voxels, returning empty data");
        return data.select({});
    }
    Point seed_cell;
    for (int a = 0; a < 3; ++a) {
        seed_cell[a] = std::clamp(int(std::floor((seed[a] - bounds.min[a]) / resolution)), 0, occupied.size[a] - 1);
    }
    // Find the same Chebyshev shell and z/y/x tie ordering without scanning empty volume.
    if (!occupied.get(seed_cell)) {
        std::array<int, 4> best { INT_MAX, INT_MAX, INT_MAX, INT_MAX };
        Point nearest = seed_cell;
        for (auto index : occupied.active_blocks()) {
            const auto p = occupied.block_point(index);
            auto bits = occupied.mask(index);
            while (bits) {
                const int bit = std::countr_zero(bits);
                bits &= bits - 1;
                Point cell { p[0] * 4 + bit % 4, p[1] * 4 + bit / 4 % 4, p[2] * 4 + bit / 16 };
                std::array<int, 4> order { std::max({ std::abs(cell[0] - seed_cell[0]), std::abs(cell[1] - seed_cell[1]), std::abs(cell[2] - seed_cell[2]) }), cell[2], cell[1], cell[0] };
                if (order < best) {
                    best = order;
                    nearest = cell;
                }
            }
        }
        seed_cell = nearest;
        logger.warn("filterCluster seed is empty; using nearest occupied voxel (", seed_cell[0], ", ", seed_cell[1], ", ", seed_cell[2], ')');
    }
    auto cluster = flood(occupied, { seed_cell });
    if (cluster.voxel_count() == occupied.voxel_count()) {
        logger.info("filterCluster: all occupied voxels are connected, no filtering needed");
        return data;
    }
    auto select = [&](const Grid& component) {
        std::vector<uint32_t> selected;
        for (uint32_t i = 0; i < data.size(); ++i) {
            const auto& gaussian = prepared.gaussians[i];
            const auto& g = gaussian.values;
            Point center;
            for (int a = 0; a < 3; ++a) {
                center[a] = int(std::floor((g[a] - bounds.min[a]) / resolution));
            }
            if (component.get(center)) {
                selected.push_back(i);
                continue;
            }
            const float maximum_extent = std::max({ g[11], g[12], g[13] });
            const float hits_needed = maximum_extent > resolution ? std::max(1.0f, std::ceil(8 * float(g[11]) * g[12] * g[13] / (resolution * resolution * resolution) * 0.1f)) : 1;
            Point minimum, maximum;
            for (int a = 0; a < 3; ++a) {
                minimum[a] = std::max(0, int(std::floor((float(g[a]) - g[11 + a] - bounds.min[a]) / (4 * resolution))));
                maximum[a] = std::min(component.blocks[a] - 1, int(std::floor((float(g[a]) + g[11 + a] - bounds.min[a]) / (4 * resolution))));
            }
            size_t hits = 0;
            for (int z = minimum[2]; z <= maximum[2] && hits < hits_needed; ++z) {
                for (int y = minimum[1]; y <= maximum[1] && hits < hits_needed; ++y) {
                    for (int x = minimum[0]; x <= maximum[0] && hits < hits_needed; ++x) {
                        auto bits = component.mask(component.block_index({ x, y, z }));
                        while (bits && hits < hits_needed) {
                            const int b = std::countr_zero(bits);
                            bits &= bits - 1;
                            std::array<float, 3> difference { bounds.min[0] + x * 4 * resolution + (b % 4 + 0.5f) * resolution - g[0],
                                bounds.min[1] + y * 4 * resolution + (b / 4 % 4 + 0.5f) * resolution - g[1], bounds.min[2] + z * 4 * resolution + (b / 16 + 0.5f) * resolution - g[2] };
                            hits += g[3] * std::exp(-0.5f * distance_squared(gaussian, difference)) >= contribution;
                        }
                    }
                }
            }
            if (hits >= hits_needed) {
                selected.push_back(i);
            }
        }
        return selected;
    };
    auto chosen = select(cluster);
    if (!options.contains("seed") && float(chosen.size()) / data.size() < 0.3f) {
        Grid processed = cluster;
        std::vector<Grid> candidates;
        for (auto index : occupied.active_blocks()) {
            auto remaining = occupied.mask(index) & ~processed.mask(index);
            while (remaining) {
                const int bit = std::countr_zero(remaining);
                const auto p = occupied.block_point(index);
                auto component = flood(occupied, { { p[0] * 4 + bit % 4, p[1] * 4 + bit / 4 % 4, p[2] * 4 + bit / 16 } });
                processed = unite(processed, component);
                candidates.push_back(std::move(component));
                std::stable_sort(candidates.begin(), candidates.end(), [](const Grid& a, const Grid& b) { return a.voxel_count() > b.voxel_count(); });
                if (candidates.size() > 5) {
                    candidates.pop_back();
                }
                remaining &= ~processed.mask(index);
            }
        }
        for (const auto& candidate : candidates) {
            auto indices = select(candidate);
            if (indices.size() > chosen.size()) {
                chosen = std::move(indices);
            }
        }
    }
    logger.info("filterCluster: kept ", chosen.size(), " / ", data.size(), " gaussians");
    return data.select(chosen);
}
} // namespace splat_transform::voxel
