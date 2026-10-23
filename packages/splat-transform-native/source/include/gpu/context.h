#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace splat_transform::gpu {
// Serialized values must match ApiType in the JavaScript wrapper.
enum class ApiType : uint32_t { Vulkan = 0 };

struct DeviceInfo {
    // Zero-based index across all APIs returned by enumerate_devices().
    uint32_t index = 0;
    std::string name;
    ApiType api;
    // API-specific raw version supported by the device. Decode in the caller.
    uint32_t api_version;
    uint32_t vendor_id;
    uint32_t device_id;
    // Backend-reported device identifier; not used for device selection.
    std::string uuid;
};

// Device selection and GPU resource/command access are single-threaded.
std::vector<DeviceInfo> enumerate_devices();
// Uses the global index from enumerate_devices(), not a backend-local index.
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
