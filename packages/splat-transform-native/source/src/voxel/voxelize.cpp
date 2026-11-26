#include "voxelize.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility/logger.h>
#include <utility/parallel.h>

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
float distance_squared(const Gaussian& gaussian, const Eigen::Vector3f& difference) {
    const auto& g = gaussian.values;
    // The GPU layout stores wxyz; Eigen's coefficient buffer stores xyzw.
    const Eigen::Quaternionf rotation(g[4], g[5], g[6], g[7]);
    const Eigen::Map<const Eigen::Vector3f> scale(g.data() + 8);
    const Eigen::Vector3f local = (rotation.conjugate() * difference).cwiseQuotient(scale.cwiseMax<Eigen::PropagateNaN>(1e-8f));
    return local.squaredNorm();
}
Gaussian pack_gaussian(const splat::Gaussian& point, Eigen::Vector3f extent) {
    Gaussian packed;
    auto& g = packed.values;
    Eigen::Map<Eigen::Vector3f>(g.data()) = point.mean;
    g[3] = point.opacity;
    g[4] = point.rotation.w();
    Eigen::Map<Eigen::Vector3f>(g.data() + 5) = point.rotation.vec();
    Eigen::Map<Eigen::Vector3f>(g.data() + 8) = point.scale;
    Eigen::Map<Eigen::Vector3f>(g.data() + 11) = extent;
    return packed;
}
PreparedData prepare(const splat::Splat& data) {
    constexpr size_t grain = 4096;
    struct Chunk {
        Eigen::AlignedBox3f bounds;
        std::vector<uint32_t> invalid;
    };
    std::vector<Chunk> chunks((data.size() + grain - 1) / grain);
    PreparedData output;
    output.scene.min().setConstant(std::numeric_limits<float>::infinity());
    output.scene.max().setConstant(-std::numeric_limits<float>::infinity());
    output.gaussians.resize(data.size());
    threading::parallel_chunks(data.size(), grain, [&](size_t begin, size_t end) {
        auto& chunk = chunks[begin / grain];
        chunk.bounds.min().setConstant(std::numeric_limits<float>::infinity());
        chunk.bounds.max().setConstant(-std::numeric_limits<float>::infinity());
        for (size_t i = begin; i < end; ++i) {
            const auto& point = data.gaussians[i];
            auto extent = extents(point);
            if (extent.allFinite()) {
                for (int32_t a = 0; a < 3; ++a) {
                    chunk.bounds.min()[a] = std::min(chunk.bounds.min()[a], point.mean[a] - extent[a]);
                    chunk.bounds.max()[a] = std::max(chunk.bounds.max()[a], point.mean[a] + extent[a]);
                }
            } else {
                extent.setZero();
                chunk.invalid.push_back(static_cast<uint32_t>(i));
            }
            output.gaussians[i] = pack_gaussian(point, extent);
        }
    });
    for (const auto& chunk : chunks) {
        output.scene.extend(chunk.bounds);
        output.invalid_extents.insert(output.invalid_extents.end(), chunk.invalid.begin(), chunk.invalid.end());
    }
    return output;
}
void PreparedData::select(std::span<const uint32_t> indices) {
    assert(std::adjacent_find(indices.begin(), indices.end(), std::greater_equal<uint32_t>()) == indices.end());
    assert(indices.empty() || indices.back() < this->gaussians.size());
    this->scene.min().setConstant(std::numeric_limits<float>::infinity());
    this->scene.max().setConstant(-std::numeric_limits<float>::infinity());
    size_t next_invalid = 0, kept_invalid = 0;
    for (size_t i = 0; i < indices.size(); ++i) {
        const auto index = indices[i];
        while (next_invalid < this->invalid_extents.size() && this->invalid_extents[next_invalid] < index) {
            ++next_invalid;
        }
        const bool valid = next_invalid == this->invalid_extents.size() || this->invalid_extents[next_invalid] != index;
        if (i != index) {
            this->gaussians[i] = this->gaussians[index];
        }
        if (!valid) {
            // Read positions advance before writing the compacted sparse list.
            ++next_invalid;
            this->invalid_extents[kept_invalid++] = static_cast<uint32_t>(i);
            continue;
        }
        const auto& g = this->gaussians[i].values;
        for (int32_t a = 0; a < 3; ++a) {
            this->scene.min()[a] = std::min(this->scene.min()[a], g[a] - g[11 + a]);
            this->scene.max()[a] = std::max(this->scene.max()[a], g[a] + g[11 + a]);
        }
    }
    this->gaussians.resize(indices.size());
    this->invalid_extents.resize(kept_invalid);
}
Eigen::AlignedBox3f align_bounds(Eigen::AlignedBox3f bounds, float resolution) {
    const float block_size = resolution * 4;
    for (int32_t a = 0; a < 3; ++a) {
        bounds.min()[a] = std::floor(bounds.min()[a] / block_size) * block_size;
        bounds.max()[a] = std::ceil(bounds.max()[a] / block_size) * block_size;
    }
    return bounds;
}
Grid make_grid(const Eigen::AlignedBox3f& bounds, float resolution) {
    Eigen::Vector3i dimensions;
    for (int32_t a = 0; a < 3; ++a) {
        dimensions[a] = std::max(4, static_cast<int32_t>(std::llround((bounds.max()[a] - bounds.min()[a]) / resolution)));
    }
    return Grid(dimensions);
}

Eigen::AlignedBox3f resolve_box(const splat::Splat& data, const Eigen::AlignedBox3f& scene, const Eigen::AlignedBox3f& box, const std::optional<DenseBoxOptions>& options) {
    if (!options || data.size() == 0) {
        return box;
    }
    const auto center = splat::bounds(data);
    float inflation = 0, center_volume = 1, scene_volume = 1;
    for (int32_t a = 0; a < 3; ++a) {
        const float c = std::max(0.0f, center.max()[a] - center.min()[a]), s = std::max(0.0f, scene.max()[a] - scene.min()[a]);
        inflation = std::max(inflation, s / std::max(c, 1e-6f));
        center_volume *= c;
        scene_volume *= s;
    }
    if (inflation < options->minimum_axis_inflation && scene_volume / std::max(center_volume, 1e-6f) < options->minimum_volume_inflation) {
        return box;
    }
    auto dense = splat::dense_bounds(data, 1 - options->target_center_keep_ratio);
    for (int32_t a = 0; a < 3; ++a) {
        dense.min()[a] = std::max(dense.min()[a], box.min()[a]);
        dense.max()[a] = std::min(dense.max()[a], box.max()[a]);
        if (dense.min()[a] >= dense.max()[a]) {
            return box;
        }
    }
    size_t kept = 0;
    for (size_t i = 0; i < data.size(); ++i) {
        bool inside = true;
        for (int32_t a = 0; a < 3; ++a) {
            inside &= data.gaussians[i].attribute(a) >= dense.min()[a] && data.gaussians[i].attribute(a) <= dense.max()[a];
        }
        kept += inside;
    }
    if (static_cast<float>(kept) / data.size() < options->minimum_center_keep_ratio) {
        return box;
    }
    utility::logger().info("autoDenseBox: applied, kept ", kept, '/', data.size(), " centers (", utility::fixed(static_cast<float>(kept) / data.size() * 100), "%)");
    return dense;
}
namespace {
Grid seed_component(const Grid& occupied, const Eigen::AlignedBox3f& bounds, float resolution, const Eigen::Vector3f& seed) {
    Eigen::Vector3i seed_cell;
    for (int32_t a = 0; a < 3; ++a) {
        const float cell = std::max(0.0f, (seed[a] - bounds.min()[a]) / resolution);
        seed_cell[a] = cell < static_cast<float>(occupied.size[a]) ? static_cast<int32_t>(cell) : occupied.size[a] - 1;
    }
    // Find the same Chebyshev shell and z/y/x tie ordering without scanning empty volume.
    if (!occupied.get(seed_cell)) {
        std::array<int32_t, 4> best;
        best.fill(std::numeric_limits<int32_t>::max());
        Eigen::Vector3i nearest = seed_cell;
        occupied.masks.for_each_block(0, [&](Eigen::Vector3i p, uint64_t bits) {
            while (bits) {
                const int32_t bit = std::countr_zero(bits);
                bits &= bits - 1;
                Eigen::Vector3i cell { p[0] * 4 + bit % 4, p[1] * 4 + bit / 4 % 4, p[2] * 4 + bit / 16 };
                std::array<int32_t, 4> order { std::max({ std::abs(cell[0] - seed_cell[0]), std::abs(cell[1] - seed_cell[1]), std::abs(cell[2] - seed_cell[2]) }), cell[2], cell[1], cell[0] };
                if (order < best) {
                    best = order;
                    nearest = cell;
                }
            }
        });
        seed_cell = nearest;
        utility::logger().warn("filterCluster seed is empty; using nearest occupied voxel (", seed_cell[0], ", ", seed_cell[1], ", ", seed_cell[2], ')');
    }
    return flood(occupied, { seed_cell });
}
Eigen::Vector3f mean_of(const Gaussian& point) { return Eigen::Map<const Eigen::Vector3f>(point.values.data()); }
const Eigen::Vector3f& mean_of(const splat::Gaussian& point) { return point.mean; }
const Gaussian& geometry_of(const Gaussian& point) { return point; }
Gaussian geometry_of(const splat::Gaussian& point) {
    // The user's contribution threshold can be below the voxelizer's opacity floor.
    return pack_gaussian(point, point.rotation.toRotationMatrix().cwiseAbs() * (3.0f * point.scale));
}

template<typename Row>
std::vector<uint32_t> select_component(const std::vector<Row>& rows, const Grid& grid, const Eigen::AlignedBox3f& bounds,
    float resolution, float min_contribution, bool check_coverage) {
    const Eigen::Vector3f grid_size = grid.size.cast<float>();
    const float block_size = 4.0f * resolution;
    return threading::select_indices(rows.size(), [&](size_t index) {
        const auto& row = rows[index];
        const auto& mean = mean_of(row);
        if (!mean.allFinite()) {
            return false;
        }
        const Eigen::Vector3f cell = (mean - bounds.min()) / resolution;
        if ((cell.array() >= 0.0f).all() && (cell.array() < grid_size.array()).all() && grid.get(cell.cast<int32_t>())) {
            return true;
        }

        // Most surface points pass the center test. Only pack geometry and
        // compute the inverse rotation/scale for splats that need a tail test.
        const auto& gaussian = geometry_of(row);
        const auto& g = gaussian.values;
        if (!(g[3] >= min_contribution)) {
            return false;
        }
        const Eigen::Map<const Eigen::Vector3f> extent(g.data() + 11);
        if (!extent.allFinite()) {
            return false;
        }
        const float hits_needed = check_coverage && extent.maxCoeff() > resolution ? std::max(1.0f, std::ceil(0.8f * (extent / resolution).prod())) : 1.0f;
        Eigen::Vector3i lo, hi;
        for (int32_t a = 0; a < 3; ++a) {
            const float low = std::floor((mean[a] - extent[a] - bounds.min()[a]) / block_size);
            const float high = std::floor((mean[a] + extent[a] - bounds.min()[a]) / block_size);
            const float block_count = static_cast<float>(grid.blocks[a]);
            if (low >= block_count || high < 0.0f) {
                return false;
            }
            lo[a] = static_cast<int32_t>(std::max(0.0f, low));
            hi[a] = high < block_count ? static_cast<int32_t>(high) : grid.blocks[a] - 1;
        }
        const Eigen::Quaternionf inverse_rotation(g[4], -g[5], -g[6], -g[7]);
        const Eigen::Vector3f inverse_scale = Eigen::Map<const Eigen::Vector3f>(g.data() + 8).cwiseMax(1e-8f).cwiseInverse();
        size_t hits = 0;
        for (int32_t z = lo.z(); z <= hi.z(); ++z) {
            for (int32_t y = lo.y(); y <= hi.y(); ++y) {
                for (int32_t x = lo.x(); x <= hi.x(); ++x) {
                    auto bits = grid.masks.get({ x, y, z });
                    while (bits) {
                        const int32_t b = std::countr_zero(bits);
                        bits &= bits - 1;
                        const Eigen::Vector3f difference {
                            bounds.min().x() + x * 4 * resolution + (b % 4 + 0.5f) * resolution - mean.x(),
                            bounds.min().y() + y * 4 * resolution + (b / 4 % 4 + 0.5f) * resolution - mean.y(),
                            bounds.min().z() + z * 4 * resolution + (b / 16 + 0.5f) * resolution - mean.z()
                        };
                        const float d2 = (inverse_rotation * difference).cwiseProduct(inverse_scale).squaredNorm();
                        if (g[3] * std::exp(-0.5f * d2) >= min_contribution && ++hits >= hits_needed) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    });
}
} // namespace

std::vector<uint32_t> filter_indices(const splat::Splat& data, const Occupancy& occupancy, float min_contribution, bool cluster) {
    if (occupancy.grid.masks.empty() || !data.size()) {
        return {};
    }
    if (cluster) {
        const auto component = seed_component(occupancy.grid, occupancy.bounds, occupancy.spec.voxel_resolution, Eigen::Vector3f::Zero());
        return select_component(data.gaussians, component, occupancy.bounds, occupancy.spec.voxel_resolution, min_contribution, true);
    }
    return select_component(data.gaussians, occupancy.grid, occupancy.bounds, occupancy.spec.voxel_resolution, min_contribution, false);
}
std::optional<Occupancy> filter_cluster(PreparedData& prepared, const FilterClusterOptions& options, const Eigen::AlignedBox3f& box, const Backend& backend) {
    auto& logger = utility::logger();
    const float resolution = options.voxel_resolution, cutoff = options.opacity_cutoff, contribution = options.min_contribution;
    if (!(resolution > 0) || !std::isfinite(resolution) || !std::isfinite(cutoff) || cutoff < 0 || cutoff > 1 || !std::isfinite(contribution) || contribution < 0) {
        throw std::runtime_error("Invalid filterCluster options");
    }
    const auto count = prepared.gaussians.size();
    if (!count) {
        return {};
    }
    auto bounds = align_bounds(prepared.scene, resolution);
    const Eigen::Vector3f seed = options.seed.value_or(Eigen::Vector3f::Zero());
    for (int32_t a = 0; a < 3; ++a) {
        bounds.min()[a] = std::max(bounds.min()[a], box.min()[a]);
        bounds.max()[a] = std::min(bounds.max()[a], box.max()[a]);
    }
    bounds = align_bounds(bounds, resolution);
    for (int32_t a = 0; a < 3; ++a) {
        if (bounds.min()[a] >= bounds.max()[a]) {
            logger.warn("filterCluster: box does not overlap scene bounds, returning empty data");
            prepared.select({});
            return {};
        }
        if (bounds.max()[a] - bounds.min()[a] > 4096 * resolution) {
            const float half = 2048 * resolution, center = std::clamp(seed[a], bounds.min()[a] + half, bounds.max()[a] - half);
            bounds.min()[a] = center - half;
            bounds.max()[a] = center + half;
        }
    }
    const GridSpec spec { resolution, cutoff };
    auto occupied = backend.voxelize(prepared, bounds, resolution, cutoff);
    const bool covers_input = bounds.contains(prepared.scene);
    const auto take_grid = [&]() -> std::optional<Occupancy> {
        if (covers_input) {
            return Occupancy { std::move(occupied), bounds, spec };
        }
        return std::nullopt;
    };
    if (!occupied.voxel_count()) {
        logger.warn("filterCluster: no occupied voxels, returning empty data");
        prepared.select({});
        return take_grid();
    }
    auto cluster = seed_component(occupied, bounds, resolution, seed);
    if (cluster.voxel_count() == occupied.voxel_count()) {
        logger.info("filterCluster: all occupied voxels are connected, no filtering needed");
        return take_grid();
    }
    auto select = [&](const Grid& component) {
        return select_component(prepared.gaussians, component, bounds, resolution, contribution, true);
    };
    auto chosen = select(cluster);
    if (!options.seed && static_cast<float>(chosen.size()) / count < 0.3f) {
        Grid processed = cluster;
        std::vector<Grid> candidates;
        for (auto index : occupied.active_blocks()) {
            auto remaining = occupied.mask(index) & ~processed.mask(index);
            while (remaining) {
                const int32_t bit = std::countr_zero(remaining);
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
    return take_grid();
}
} // namespace splat_transform::voxel
