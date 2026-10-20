#pragma once
#include "grid.h"
#include <io/file.h>
#include <string_view>

namespace splat_transform::voxel {
struct PreparedData;

// One backend instance is shared by cluster filtering, final voxelization, and
// navigation. Implementations own their execution policy, not the pipeline.
class Backend {
public:
    virtual ~Backend() = default;
    virtual std::string_view name() const noexcept = 0;
    virtual bool requires_gpu() const noexcept = 0;
    virtual Grid voxelize(const PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff) const = 0;
    virtual Grid dilate(const Grid& grid, Eigen::Vector3i radius) const = 0;
};

const Backend& cpu_backend();
const Backend& gpu_backend();
// Resolve once per voxel task so filtering, generation, and navigation share
// the same backend. Unavailable GPU initialization selects CPU for all phases.
const Backend& resolve_backend(const io::Json& config);
} // namespace splat_transform::voxel
