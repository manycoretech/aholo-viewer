#pragma once
#include "grid.h"
#include <io/file.h>
#include <memory>
#include <string_view>

namespace splat_transform::voxel {
struct PreparedData;

// One task-owned backend is shared by filtering, generation, and navigation.
// GPU implementations retain their session until the whole operation finishes.
class Backend {
public:
    virtual ~Backend() = default;
    virtual std::string_view name() const noexcept = 0;
    virtual bool requires_gpu() const noexcept = 0;
    virtual Grid voxelize(const PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff) const = 0;
    virtual Grid dilate(const Grid& grid, Eigen::Vector3i radius) const = 0;
};

std::unique_ptr<Backend> cpu_backend();
std::unique_ptr<Backend> gpu_backend();
// Resolve once per voxel task so filtering, generation, and navigation share
// the same backend. Unavailable GPU initialization selects CPU for all phases.
std::unique_ptr<Backend> resolve_backend(const io::Json& config);
} // namespace splat_transform::voxel
