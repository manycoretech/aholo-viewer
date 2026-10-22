#pragma once
#include <gpu/compute.h>
#include <gpu/context.h>
#include <utility>

namespace splat_transform::gpu::detail {
// Native handles stay behind these interfaces. Public compute code owns
// validation without native API dependencies. Callers own resource lifetimes.
class BackendBuffer {
public:
    virtual ~BackendBuffer() = default;
    virtual std::byte* mapped_data() = 0;
    virtual void flush() = 0;
    virtual void invalidate() = 0;
};
class BackendPipeline {
public:
    virtual ~BackendPipeline() = default;
};
class BackendDescriptorTable {
public:
    virtual ~BackendDescriptorTable() = default;
};
struct BackendRange {
    BackendBuffer* buffer;
    size_t offset;
    size_t size;
};
class BackendCommands {
public:
    // Callers keep recordings and referenced resources alive until completion.
    // Transfer/compute barriers remain adapter responsibilities.
    virtual ~BackendCommands() = default;
    virtual void reset() = 0;
    virtual void begin() = 0;
    virtual void copy(const BackendRange& source, const BackendRange& destination) = 0;
    virtual void fill(const BackendRange& buffer, uint32_t value) = 0;
    virtual void bind_pipeline(BackendPipeline& pipeline) = 0;
    virtual void bind_descriptor_table(BackendDescriptorTable& table) = 0;
    virtual void push_constants(std::span<const std::byte> push) = 0;
    virtual void dispatch(std::array<uint32_t, 3> groups) = 0;
    virtual void end() = 0;
};
class BackendFence {
public:
    virtual ~BackendFence() = default;
    virtual uint64_t completed_value() const = 0;
};
class BackendQueue {
public:
    // The default queue is ordered. CPU waits on a fence complete all submissions
    // before it. Callers must wait before destroying pending resources.
    virtual ~BackendQueue() = default;
    virtual void submit(BackendCommands& commands, BackendFence& fence, uint64_t value) = 0;
    virtual void wait_cpu(BackendFence& fence, uint64_t value) = 0;
    virtual void wait_cpu() = 0;
};
class BackendDevice {
public:
    virtual ~BackendDevice() = default;
    virtual ComputeLimits limits() const = 0;
    virtual size_t available_memory() const = 0;
    virtual size_t allocation_bytes() const = 0;
    virtual std::unique_ptr<BackendBuffer> create_buffer(size_t size, BufferMemory memory, bool within_budget) = 0;
    virtual std::unique_ptr<BackendPipeline> create_pipeline(const ComputeShader& shader) = 0;
    virtual std::unique_ptr<BackendDescriptorTable> create_descriptor_table(BackendPipeline& pipeline, std::span<const BackendRange> buffers) = 0;
    virtual std::unique_ptr<BackendCommands> create_commands() = 0;
    virtual std::unique_ptr<BackendQueue> create_queue() = 0;
    virtual std::unique_ptr<BackendFence> create_fence(uint64_t initial_value) = 0;
};
struct DeviceState {
    explicit DeviceState(std::unique_ptr<BackendDevice> device) : backend(std::move(device)), limits(backend->limits()) {}
    // The top-level DeviceGuard controls this context's lifetime. Views borrow it.
    std::unique_ptr<BackendDevice> backend;
    ComputeLimits limits;
    std::unique_ptr<Queue> queue;
};
DeviceState& context();
// Backend selection stays here; tasks never include this header.
std::unique_ptr<BackendDevice> create_vulkan_device(uint32_t index);
std::vector<DeviceInfo> enumerate_vulkan_devices();
} // namespace splat_transform::gpu::detail
