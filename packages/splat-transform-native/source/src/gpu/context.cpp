#include "backend.h"
#include <stdexcept>
#include <utility>

namespace splat_transform::gpu {
namespace detail {
void DeviceRegistry::append(std::vector<DeviceInfo> devices, Factory factory) {
    uint32_t backend_index = 0;
    for (auto& info : devices) {
        info.index = static_cast<uint32_t>(entries_.size());
        entries_.push_back({ std::move(info), backend_index++, factory });
    }
}
std::vector<DeviceInfo> DeviceRegistry::devices() const {
    std::vector<DeviceInfo> result;
    result.reserve(entries_.size());
    for (const auto& entry : entries_) {
        result.push_back(entry.info);
    }
    return result;
}
std::unique_ptr<BackendDevice> DeviceRegistry::create(uint32_t index) const {
    if (index >= entries_.size()) {
        throw std::runtime_error("GPU device index is unavailable; run list:gpu to select a device");
    }
    const auto& entry = entries_[index];
    return entry.factory(entry.backend_index);
}
namespace {
uint32_t selected_device = 0;
std::unique_ptr<DeviceState> device_context;
DeviceRegistry enumerate_registry() {
    DeviceRegistry registry;
    registry.append(enumerate_vulkan_devices(), create_vulkan_device);
    return registry;
}
} // namespace
DeviceState& context() {
    if (!device_context) {
        device_context = std::make_unique<DeviceState>(enumerate_registry().create(selected_device));
    }
    return *device_context;
}
} // namespace detail
std::vector<DeviceInfo> enumerate_devices() { return detail::enumerate_registry().devices(); }
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
