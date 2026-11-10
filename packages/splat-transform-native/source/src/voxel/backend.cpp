#include "backend.h"
#include <utility/logger.h>
#include <voxel/voxel.h>

namespace splat_transform::voxel {
bool requires_gpu(BackendType backend) {
    // Inspect configuration without constructing a session: the pipeline must
    // select its adapter before resolution initializes the task's GPU device.
    return backend == BackendType::Gpu;
}
std::unique_ptr<Backend> resolve_backend(BackendType backend) {
    if (!requires_gpu(backend)) {
        return cpu_backend();
    }
    try {
        return gpu_backend();
    } catch (const std::exception& error) {
        utility::logger().warn("Voxel GPU initialization failed; using CPU for this task: ", error.what());
        return cpu_backend();
    }
}
} // namespace splat_transform::voxel
