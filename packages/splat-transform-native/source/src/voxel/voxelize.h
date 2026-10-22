#pragma once
#include "backend.h"
#include "compute.h"
#include <io/file.h>

namespace splat_transform::voxel {
inline constexpr float ALPHA_THRESHOLD = 1.0f / 255;
Eigen::Vector3f extents(const splat::Gaussian& gaussian);
float distance_squared(const Gaussian& gaussian, const Eigen::Vector3f& difference);
struct PreparedData {
    std::vector<Gaussian> gaussians;
    Eigen::AlignedBox3f scene;
    // Sparse, sorted indices distinguish invalid extents from valid zero extents.
    std::vector<uint32_t> invalid_extents;
    // Indices must be strictly increasing, as produced by cluster selection.
    void select(std::span<const uint32_t> indices);
};
PreparedData prepare(const splat::Splat& data);
Eigen::AlignedBox3f align_bounds(Eigen::AlignedBox3f bounds, float resolution);
Grid make_grid(const Eigen::AlignedBox3f& bounds, float resolution);
void filter_cluster(PreparedData& data, const io::Json& options, const Eigen::AlignedBox3f& box, const Backend& backend);
Eigen::AlignedBox3f resolve_box(const splat::Splat& data, const Eigen::AlignedBox3f& scene, const io::Json& config);
} // namespace splat_transform::voxel
