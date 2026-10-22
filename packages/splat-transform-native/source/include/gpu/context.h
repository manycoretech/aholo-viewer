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

// Device selection and GPU resource/command access are single-threaded.
std::vector<DeviceInfo> enumerate_devices();
// Changing the index releases the current context. Finish GPU work and destroy
// all resources borrowing it before switching devices.
void select_device(uint32_t index);

// Releases the single shared-use context on scope exit. Keep this top-level
// scope outside all borrowed device views and resources. No implicit GPU wait.
class DeviceGuard {
public:
    DeviceGuard() = default;
    ~DeviceGuard();
    DeviceGuard(const DeviceGuard&) = delete;
    DeviceGuard& operator=(const DeviceGuard&) = delete;
};
} // namespace splat_transform::gpu
