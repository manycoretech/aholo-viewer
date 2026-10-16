#pragma once
#include "grid.h"
#include <gpu/compute.h>
#include <io/file.h>

namespace splat_transform::voxel {
inline constexpr float ALPHA_THRESHOLD = 1.0f / 255;
Eigen::Vector3f extents(const splat::Gaussian& gaussian);
float distance_squared(const gpu::Gaussian& gaussian, const Eigen::Vector3f& difference);
struct PreparedData {
    std::vector<gpu::Gaussian> gaussians;
    Eigen::AlignedBox3f scene;
    // Sparse, sorted indices distinguish invalid extents from valid zero extents.
    std::vector<uint32_t> invalid_extents;
    // Indices must be strictly increasing, as produced by cluster selection.
    void select(std::span<const uint32_t> indices);
};
PreparedData prepare(const splat::Splat& data);
Eigen::AlignedBox3f align_bounds(Eigen::AlignedBox3f bounds, float resolution);
Grid voxelize(const PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff);
void filter_cluster(PreparedData& data, const io::Json& options, const Eigen::AlignedBox3f& box);
Eigen::AlignedBox3f resolve_box(const splat::Splat& data, const Eigen::AlignedBox3f& scene, const io::Json& config);
} // namespace splat_transform::voxel
