#include "backend.h"
#include <utility>

namespace splat_transform::gpu {
namespace detail {
namespace {
uint32_t selected_device = 0;
std::unique_ptr<DeviceState> device_context;
} // namespace
DeviceState& context() {
    if (!device_context) {
        device_context = std::make_unique<DeviceState>(create_vulkan_device(selected_device));
    }
    return *device_context;
}
} // namespace detail
std::vector<DeviceInfo> enumerate_devices() { return detail::enumerate_vulkan_devices(); }
void select_device(uint32_t index) {
    if (index != detail::selected_device) {
        detail::device_context.reset();
    }
    detail::selected_device = index;
}
DeviceGuard::~DeviceGuard() {
    detail::device_context.reset();
}
} // namespace splat_transform::gpu
