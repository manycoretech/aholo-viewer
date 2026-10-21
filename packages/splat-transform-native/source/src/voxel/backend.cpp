#include "backend.h"
#include <utility/logger.h>
#include <voxel/voxel.h>

namespace splat_transform::voxel {
bool requires_gpu(const io::Json& config) {
    // Inspect configuration without constructing a session: the pipeline must
    // select its adapter before resolution initializes the task's GPU device.
    const auto name = config.value("backend", std::string("gpu"));
    if (name == "cpu") {
        return false;
    }
    if (name == "gpu") {
        return true;
    }
    throw std::runtime_error("Voxel backend must be cpu or gpu");
}
std::unique_ptr<Backend> resolve_backend(const io::Json& config) {
    if (!requires_gpu(config)) {
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
