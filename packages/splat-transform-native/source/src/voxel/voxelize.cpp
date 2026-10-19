#include "voxelize.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <limits>
#include <utility/logger.h>

namespace splat_transform::voxel {
Eigen::Vector3f extents(const splat::Gaussian& gaussian) {
    const float opacity = gaussian.opacity;
    if (opacity <= ALPHA_THRESHOLD) {
        return Eigen::Vector3f::Zero();
    }
    float extend = 3;
    const float aware = std::sqrt(2 * std::log(opacity / ALPHA_THRESHOLD));
    if (std::isfinite(aware)) {
        extend = std::min(extend, aware);
    }
    const Eigen::Vector3f scale = extend * gaussian.scale;
    return gaussian.rotation.toRotationMatrix().cwiseAbs() * scale;
}
float distance_squared(const gpu::Gaussian& gaussian, const Eigen::Vector3f& difference) {
    const auto& g = gaussian.values;
    // The GPU layout stores wxyz; Eigen's coefficient buffer stores xyzw.
    const Eigen::Quaternionf rotation(g[4], g[5], g[6], g[7]);
    const Eigen::Map<const Eigen::Vector3f> scale(g.data() + 8);
    const Eigen::Vector3f local = (rotation.conjugate() * difference).cwiseQuotient(scale.cwiseMax<Eigen::PropagateNaN>(1e-8f));
    return local.squaredNorm();
}
PreparedData prepare(const splat::Splat& data) {
    PreparedData output;
    output.gaussians.resize(data.size());
    output.scene.min().setConstant(INFINITY);
    output.scene.max().setConstant(-INFINITY);
    for (size_t i = 0; i < data.size(); ++i) {
        auto e = extents(data.gaussians[i]);
        const bool valid = e.allFinite();
        if (!valid) {
            e.setZero();
            output.invalid_extents.push_back(uint32_t(i));
        }
        auto& g = output.gaussians[i].values;
        for (int a = 0; a < 3; ++a) {
            g[a] = data.gaussians[i].attribute(splat::X + a);
            g[8 + a] = data.gaussians[i].attribute(splat::ScaleX + a);
            g[11 + a] = float(e[a]);
            if (valid) {
                output.scene.min()[a] = std::min(output.scene.min()[a], g[a] - e[a]);
                output.scene.max()[a] = std::max(output.scene.max()[a], g[a] + e[a]);
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
void PreparedData::select(std::span<const uint32_t> indices) {
    assert(std::adjacent_find(indices.begin(), indices.end(), std::greater_equal<uint32_t>()) == indices.end());
    assert(indices.empty() || indices.back() < gaussians.size());
    scene.min().setConstant(INFINITY);
    scene.max().setConstant(-INFINITY);
    size_t next_invalid = 0, kept_invalid = 0;
    for (size_t i = 0; i < indices.size(); ++i) {
        const auto index = indices[i];
        while (next_invalid < invalid_extents.size() && invalid_extents[next_invalid] < index) {
            ++next_invalid;
        }
        const bool valid = next_invalid == invalid_extents.size() || invalid_extents[next_invalid] != index;
        if (i != index) {
            gaussians[i] = gaussians[index];
        }
        if (!valid) {
            // Read positions advance before writing the compacted sparse list.
            ++next_invalid;
            invalid_extents[kept_invalid++] = uint32_t(i);
            continue;
        }
        const auto& g = gaussians[i].values;
        for (int a = 0; a < 3; ++a) {
            scene.min()[a] = std::min(scene.min()[a], g[a] - g[11 + a]);
            scene.max()[a] = std::max(scene.max()[a], g[a] + g[11 + a]);
        }
    }
    gaussians.resize(indices.size());
    invalid_extents.resize(kept_invalid);
}
Eigen::AlignedBox3f align_bounds(Eigen::AlignedBox3f bounds, float resolution) {
    const float block_size = resolution * 4;
    for (int a = 0; a < 3; ++a) {
        bounds.min()[a] = std::floor(bounds.min()[a] / block_size) * block_size;
        bounds.max()[a] = std::ceil(bounds.max()[a] / block_size) * block_size;
    }
    return bounds;
}
Grid make_grid(const Eigen::AlignedBox3f& bounds, float resolution) {
    Point dimensions;
    for (int a = 0; a < 3; ++a) {
        dimensions[a] = std::max(4, int(std::llround((bounds.max()[a] - bounds.min()[a]) / resolution)));
    }
    return Grid(dimensions);
}

Eigen::AlignedBox3f resolve_box(const splat::Splat& data, const Eigen::AlignedBox3f& scene, const io::Json& config) {
    Eigen::AlignedBox3f box(Eigen::Vector3f::Constant(-100), Eigen::Vector3f::Constant(100));
    if (config.contains("box")) {
        const auto minimum = config.at("box").at("minCorner").get<std::array<float, 3>>();
        const auto maximum = config.at("box").at("maxCorner").get<std::array<float, 3>>();
        box.min() = Eigen::Map<const Eigen::Vector3f>(minimum.data());
        box.max() = Eigen::Map<const Eigen::Vector3f>(maximum.data());
    }
    const auto automatic = config.value("autoDenseBox", io::Json(true));
    if (automatic == false || data.size() == 0) {
        return box;
    }
    const auto options = automatic.is_object() ? automatic : io::Json::object();
    const auto center = splat::bounds(data);
    float inflation = 0, center_volume = 1, scene_volume = 1;
    for (int a = 0; a < 3; ++a) {
        const float c = std::max(0.0f, center.max()[a] - center.min()[a]), s = std::max(0.0f, scene.max()[a] - scene.min()[a]);
        inflation = std::max(inflation, s / std::max(c, 1e-6f));
        center_volume *= c;
        scene_volume *= s;
    }
    if (inflation < options.value("minimumAxisInflation", 1.5f) && scene_volume / std::max(center_volume, 1e-6f) < options.value("minimumVolumeInflation", 4.0f)) {
        return box;
    }
    auto dense = splat::dense_bounds(data, 1 - options.value("targetCenterKeepRatio", 0.98f));
    for (int a = 0; a < 3; ++a) {
        dense.min()[a] = std::max(dense.min()[a], box.min()[a]);
        dense.max()[a] = std::min(dense.max()[a], box.max()[a]);
        if (dense.min()[a] >= dense.max()[a]) {
            return box;
        }
    }
    size_t kept = 0;
    for (size_t i = 0; i < data.size(); ++i) {
        bool inside = true;
        for (int a = 0; a < 3; ++a) {
            inside &= data.gaussians[i].attribute(a) >= dense.min()[a] && data.gaussians[i].attribute(a) <= dense.max()[a];
        }
        kept += inside;
    }
    if (float(kept) / data.size() < options.value("minimumCenterKeepRatio", 0.95f)) {
        return box;
    }
    utility::logger().info("autoDenseBox: applied, kept ", kept, '/', data.size(), " centers (", utility::fixed(float(kept) / data.size() * 100), "%)");
    return dense;
}
void filter_cluster(PreparedData& prepared, const io::Json& options, const Eigen::AlignedBox3f& box, const Backend& backend) {
    auto& logger = utility::logger();
    const float resolution = options.value("voxelResolution", 1.0f), cutoff = options.value("opacityCutoff", 0.999f), contribution = options.value("minContribution", 0.1f);
    if (!(resolution > 0) || !std::isfinite(resolution) || !std::isfinite(cutoff) || cutoff < 0 || cutoff > 1 || !std::isfinite(contribution) || contribution < 0) {
        throw std::runtime_error("Invalid filterCluster options");
    }
    const auto count = prepared.gaussians.size();
    if (!count) {
        return;
    }
    auto bounds = align_bounds(prepared.scene, resolution);
    Eigen::Vector3f seed = Eigen::Vector3f::Zero();
    if (options.contains("seed")) {
        const auto& s = options.at("seed");
        seed = { s.at("x").get<float>(), s.at("y").get<float>(), s.at("z").get<float>() };
    }
    for (int a = 0; a < 3; ++a) {
        bounds.min()[a] = std::max(bounds.min()[a], box.min()[a]);
        bounds.max()[a] = std::min(bounds.max()[a], box.max()[a]);
    }
    bounds = align_bounds(bounds, resolution);
    for (int a = 0; a < 3; ++a) {
        if (bounds.min()[a] >= bounds.max()[a]) {
            logger.warn("filterCluster: box does not overlap scene bounds, returning empty data");
            prepared.select({});
            return;
        }
        if (bounds.max()[a] - bounds.min()[a] > 4096 * resolution) {
            const float half = 2048 * resolution, center = std::clamp(seed[a], bounds.min()[a] + half, bounds.max()[a] - half);
            bounds.min()[a] = center - half;
            bounds.max()[a] = center + half;
        }
    }
    const auto occupied = backend.voxelize(prepared, bounds, resolution, cutoff);
    if (!occupied.voxel_count()) {
        logger.warn("filterCluster: no occupied voxels, returning empty data");
        prepared.select({});
        return;
    }
    Point seed_cell;
    for (int a = 0; a < 3; ++a) {
        seed_cell[a] = std::clamp(int(std::floor((seed[a] - bounds.min()[a]) / resolution)), 0, occupied.size[a] - 1);
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
        return;
    }
    auto select = [&](const Grid& component) {
        std::vector<uint32_t> selected;
        for (uint32_t i = 0; i < count; ++i) {
            const auto& gaussian = prepared.gaussians[i];
            const auto& g = gaussian.values;
            Point center;
            for (int a = 0; a < 3; ++a) {
                center[a] = int(std::floor((g[a] - bounds.min()[a]) / resolution));
            }
            if (component.get(center)) {
                selected.push_back(i);
                continue;
            }
            const float maximum_extent = std::max({ g[11], g[12], g[13] });
            const float hits_needed = maximum_extent > resolution ? std::max(1.0f, std::ceil(8 * float(g[11]) * g[12] * g[13] / (resolution * resolution * resolution) * 0.1f)) : 1;
            Point minimum, maximum;
            for (int a = 0; a < 3; ++a) {
                minimum[a] = std::max(0, int(std::floor((float(g[a]) - g[11 + a] - bounds.min()[a]) / (4 * resolution))));
                maximum[a] = std::min(component.blocks[a] - 1, int(std::floor((float(g[a]) + g[11 + a] - bounds.min()[a]) / (4 * resolution))));
            }
            size_t hits = 0;
            for (int z = minimum[2]; z <= maximum[2] && hits < hits_needed; ++z) {
                for (int y = minimum[1]; y <= maximum[1] && hits < hits_needed; ++y) {
                    for (int x = minimum[0]; x <= maximum[0] && hits < hits_needed; ++x) {
                        auto bits = component.mask(component.block_index({ x, y, z }));
                        while (bits && hits < hits_needed) {
                            const int b = std::countr_zero(bits);
                            bits &= bits - 1;
                            const Eigen::Vector3f difference { bounds.min()[0] + x * 4 * resolution + (b % 4 + 0.5f) * resolution - g[0],
                                bounds.min()[1] + y * 4 * resolution + (b / 4 % 4 + 0.5f) * resolution - g[1], bounds.min()[2] + z * 4 * resolution + (b / 16 + 0.5f) * resolution - g[2] };
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
    if (!options.contains("seed") && float(chosen.size()) / count < 0.3f) {
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
    logger.info("filterCluster: kept ", chosen.size(), " / ", count, " gaussians");
    prepared.select(chosen);
}
} // namespace splat_transform::voxel
