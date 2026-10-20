#include "backend.h"
#include "gpu/vulkan_context.h"
#include <utility/logger.h>
#include <voxel/voxel.h>

namespace splat_transform::voxel {
namespace {
const Backend& requested_backend(const io::Json& config) {
    const auto name = config.value("backend", std::string("gpu"));
    if (name == "cpu") {
        return cpu_backend();
    }
    if (name == "gpu") {
        return gpu_backend();
    }
    throw std::runtime_error("Voxel backend must be cpu or gpu");
}
} // namespace

bool requires_gpu(const io::Json& config) {
    // The pipeline must select its GPU index before backend resolution starts
    // device initialization. This query only inspects the requested backend.
    return requested_backend(config).requires_gpu();
}

const Backend& resolve_backend(const io::Json& config) {
    const auto& backend = requested_backend(config);
    if (!backend.requires_gpu()) {
        return backend;
    }
    try {
        gpu::vulkan::context();
        return backend;
    } catch (const std::exception& error) {
        utility::logger().warn("Voxel GPU initialization failed; using CPU for this task: ", error.what());
        return cpu_backend();
    }
}
} // namespace splat_transform::voxel
