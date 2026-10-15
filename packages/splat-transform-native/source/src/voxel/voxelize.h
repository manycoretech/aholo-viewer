#pragma once
#include "grid.h"
#include <gpu/compute.h>
#include <io/file.h>

namespace splat_transform::voxel {
inline constexpr float ALPHA_THRESHOLD = 1.0f / 255;
struct PreparedData {
    std::vector<gpu::Gaussian> gaussians;
    splat::Bounds scene;
    size_t invalid_extents = 0;
};
PreparedData prepare(const splat::Splat& data);
splat::Bounds align_bounds(splat::Bounds bounds, float resolution);
Grid voxelize(const PreparedData& data, const splat::Bounds& bounds, float resolution, float cutoff);
splat::Splat filter_cluster(const splat::Splat& data, const io::Json& options, const splat::Bounds& box);
splat::Bounds resolve_box(const splat::Splat& data, const io::Json& config);
} // namespace splat_transform::voxel
