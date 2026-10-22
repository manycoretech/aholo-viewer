#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace splat_transform::gpu {
namespace detail {
struct DeviceState;
struct QueueState;
struct FenceState;
} // namespace detail

struct SpecializationConstant {
    uint32_t id;
    uint32_t value;
    bool operator==(const SpecializationConstant&) const = default;
};
// Generated shader assets are opaque to task code. The backend interprets
// their compiled bytes; the current build produces SPIR-V for Vulkan.
struct ShaderCode {
    std::span<const uint8_t> bytes;
};
enum class BufferAccess { Read,
    ReadWrite };
struct ComputeShader {
    std::string name;
    ShaderCode code;
    // Ordered storage-buffer slots in descriptor table 0.
    std::vector<BufferAccess> bindings;
    uint32_t push_constant_bytes = 0;
    std::vector<SpecializationConstant> constants {};
    std::string entry_point = "main";
};
struct ComputeLimits {
    size_t storage_buffer_bytes;
    size_t buffer_offset_alignment;
    uint32_t storage_buffer_bindings;
    uint32_t push_constant_bytes;
    uint32_t shared_memory_bytes;
    std::array<uint32_t, 3> workgroup_count;
    std::array<uint32_t, 3> workgroup_size;
    uint32_t workgroup_invocations;
};
enum class BufferMemory { Device,
    Upload,
    Readback };
class AllocationFailure : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Move-only owners. The caller keeps the DeviceGuard and referenced resources
// alive until GPU use completes; bindings and commands never retain resources.
// Host access requires completion of any commands using this buffer.
class Buffer {
public:
    Buffer();
    ~Buffer();
    Buffer(Buffer&&) noexcept;
    Buffer& operator=(Buffer&&) noexcept;
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;
    explicit operator bool() const { return bool(impl_); }
    size_t size() const;
    std::byte* mapped_data() const;
    void flush() const;
    void upload(std::span<const std::byte> data) const;
    void read_into(std::span<std::byte> output, size_t offset = 0) const;

private:
    friend class ComputeDevice;
    friend class CommandList;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
class ComputePipeline {
public:
    ComputePipeline();
    ~ComputePipeline();
    ComputePipeline(ComputePipeline&&) noexcept;
    ComputePipeline& operator=(ComputePipeline&&) noexcept;
    ComputePipeline(const ComputePipeline&) = delete;
    ComputePipeline& operator=(const ComputePipeline&) = delete;
    explicit operator bool() const { return bool(impl_); }

private:
    friend class ComputeDevice;
    friend class CommandList;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
struct BufferRange {
    const Buffer* buffer = nullptr;
    size_t offset = 0;
    // Zero binds the remainder of the buffer.
    size_t size = 0;
};
// Immutable buffer bindings that borrow their resources and creating device.
// Reuse with pipelines declaring the same ordered BufferAccess layout.
// Updating buffer contents does not require a new table; changing a range does.
class DescriptorTable {
public:
    DescriptorTable();
    ~DescriptorTable();
    DescriptorTable(DescriptorTable&&) noexcept;
    DescriptorTable& operator=(DescriptorTable&&) noexcept;
    DescriptorTable(const DescriptorTable&) = delete;
    DescriptorTable& operator=(const DescriptorTable&) = delete;
    explicit operator bool() const { return bool(impl_); }

private:
    friend class ComputeDevice;
    friend class CommandList;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Records compute/transfer commands with borrowed resource references.
// Observe completion with wait_cpu()/completed_value() before resetting or
// destroying submitted commands, their fence, or any referenced resources.
// begin() requires a new or explicitly reset list; reset() discards recording
// state and resource bindings without submitting or waiting for GPU work.
class CommandList {
public:
    CommandList();
    ~CommandList();
    CommandList(CommandList&&) noexcept;
    CommandList& operator=(CommandList&&) noexcept;
    CommandList(const CommandList&) = delete;
    CommandList& operator=(const CommandList&) = delete;
    void reset();
    void begin();
    void copy(const Buffer& source, const Buffer& destination, size_t size, size_t source_offset = 0, size_t destination_offset = 0);
    void fill(const Buffer& buffer, uint32_t value = 0, size_t size = 0, size_t offset = 0);
    // Binding a pipeline invalidates the previous table/constant bindings.
    void bind_pipeline(const ComputePipeline& pipeline);
    void bind_pipeline(ComputePipeline&&) = delete;
    void bind_descriptor_table(const DescriptorTable& table);
    void bind_descriptor_table(DescriptorTable&&) = delete;
    void push_constants(std::span<const std::byte> push);
    void dispatch(std::array<uint32_t, 3> groups);
    void end();

private:
    friend class ComputeDevice;
    friend class Queue;
    friend struct detail::QueueState;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
// Caller-owned, monotonically increasing completion progress. Polling retires
// completed submissions; successful submissions allocate consecutive values.
class Fence {
public:
    Fence();
    ~Fence();
    Fence(Fence&&) noexcept;
    Fence& operator=(Fence&&) noexcept;
    Fence(const Fence&) = delete;
    Fence& operator=(const Fence&) = delete;
    explicit operator bool() const { return bool(state_); }
    uint64_t completed_value() const;

private:
    friend class Queue;
    friend class ComputeDevice;
    std::unique_ptr<detail::FenceState> state_;
};
// Queue operations use the same single-thread host contract as device selection.
// wait_cpu() blocks the CPU; it does not enqueue a GPU-side dependency.
// The device owns its default queue. Destruction never waits implicitly.
class Queue {
public:
    Queue();
    ~Queue();
    Queue(const Queue&) = delete;
    Queue& operator=(const Queue&) = delete;
    Queue(Queue&&) = delete;
    Queue& operator=(Queue&&) = delete;
    // Returns the fence's next completion value; failure does not advance it.
    uint64_t submit(CommandList& commands, Fence& fence) const;
    // The value must be covered by the initial value or an existing submission.
    void wait_cpu(const Fence& fence, uint64_t value) const;
    void wait_cpu() const;

private:
    friend class ComputeDevice;
    std::unique_ptr<detail::QueueState> state_;
};
// Copyable borrowed view of the current device context. Copying or
// destroying this view never extends or ends the context's lifetime.
class ComputeDevice {
public:
    ComputeDevice();
    const ComputeLimits& limits() const;
    size_t available_memory() const;
    size_t allocation_bytes() const;
    size_t linear_item_limit(uint32_t group_size) const;
    std::array<uint32_t, 3> linear_groups(size_t count, uint32_t group_size) const;
    Buffer create_buffer(size_t size, BufferMemory memory = BufferMemory::Device, bool within_budget = false) const;
    ComputePipeline create_pipeline(const ComputeShader& shader) const;
    // BufferRange[i] populates slot i of the pipeline's descriptor table layout.
    DescriptorTable create_descriptor_table(const ComputePipeline& pipeline, std::span<const BufferRange> buffers) const;
    CommandList create_commands() const;
    Queue& default_queue() const;
    Fence create_fence(uint64_t initial_value = 0) const;
    bool operator==(const ComputeDevice& other) const = default;

private:
    detail::DeviceState& state() const;
    detail::DeviceState* state_;
};

} // namespace splat_transform::gpu
