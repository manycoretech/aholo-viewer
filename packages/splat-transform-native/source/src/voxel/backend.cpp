#include "backend.h"
#include <voxel/voxel.h>

namespace splat_transform::voxel {
const Backend& resolve_backend(const io::Json& config) {
    const auto name = config.value("backend", std::string("gpu"));
    if (name == "cpu") {
        return cpu_backend();
    }
    if (name == "gpu") {
        return gpu_backend();
    }
    throw std::runtime_error("Voxel backend must be cpu or gpu");
}
bool requires_gpu(const io::Json& config) {
    return resolve_backend(config).requires_gpu();
}
} // namespace splat_transform::voxel
