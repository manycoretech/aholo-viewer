#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace splat_transform::gpu {
struct DeviceInfo {
    uint32_t index;
    std::string name;
    uint32_t vendor_id;
    uint32_t device_id;
    uint32_t api_version;
    std::string uuid;
};

std::vector<DeviceInfo> enumerate_devices();
void select_device(uint32_t index);

// Releases the shared device context on scope exit. Construction does not initialize a device.
class DeviceGuard {
public:
    DeviceGuard() = default;
    ~DeviceGuard();
    DeviceGuard(const DeviceGuard&) = delete;
    DeviceGuard& operator=(const DeviceGuard&) = delete;
};
} // namespace splat_transform::gpu
