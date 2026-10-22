#include "backend.h"
#include <algorithm>
#include <cstring>
#include <deque>
#include <utility>

namespace splat_transform::gpu {
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
void check_range(size_t capacity, size_t offset, size_t size) {
    require(offset <= capacity && size <= capacity - offset, "GPU buffer range is out of bounds");
}
void check_transfer(size_t offset, size_t size) {
    require(size && offset % 4 == 0 && size % 4 == 0, "GPU transfers require a nonempty, four-byte-aligned range");
}
} // namespace

struct Buffer::Impl {
    detail::DeviceState* state;
    size_t size;
    BufferMemory memory;
    std::unique_ptr<detail::BackendBuffer> resource;
};
Buffer::Buffer() = default;
Buffer::~Buffer() = default;
Buffer::Buffer(Buffer&&) noexcept = default;
Buffer& Buffer::operator=(Buffer&&) noexcept = default;
size_t Buffer::size() const { return impl_ ? impl_->size : 0; }
std::byte* Buffer::mapped_data() const {
    require(impl_ && impl_->memory == BufferMemory::Upload, "GPU mapping requires an upload buffer");
    return impl_->resource->mapped_data();
}
void Buffer::flush() const {
    require(impl_ && impl_->memory == BufferMemory::Upload, "GPU buffer is not host accessible");
    impl_->resource->flush();
}
void Buffer::upload(std::span<const std::byte> data) const {
    require(impl_ && impl_->memory == BufferMemory::Upload, "GPU upload requires an upload buffer");
    auto* destination = mapped_data();
    check_range(size(), 0, data.size());
    if (!data.empty()) {
        std::memcpy(destination, data.data(), data.size());
        flush();
    }
}
void Buffer::read_into(std::span<std::byte> output, size_t offset) const {
    require(impl_ && impl_->memory == BufferMemory::Readback, "GPU readback requires a readback buffer");
    const auto* source = impl_->resource->mapped_data();
    check_range(size(), offset, output.size());
    if (!output.empty()) {
        impl_->resource->invalidate();
        std::memcpy(output.data(), source + offset, output.size());
    }
}
struct ComputePipeline::Impl {
    detail::DeviceState* state;
    std::vector<BufferAccess> bindings;
    uint32_t push_constant_bytes;
    std::unique_ptr<detail::BackendPipeline> resource;
};
ComputePipeline::ComputePipeline() = default;
ComputePipeline::~ComputePipeline() = default;
ComputePipeline::ComputePipeline(ComputePipeline&&) noexcept = default;
ComputePipeline& ComputePipeline::operator=(ComputePipeline&&) noexcept = default;
struct DescriptorTable::Impl {
    detail::DeviceState* state;
    std::vector<BufferAccess> bindings;
    std::unique_ptr<detail::BackendDescriptorTable> resource;
};
DescriptorTable::DescriptorTable() = default;
DescriptorTable::~DescriptorTable() = default;
DescriptorTable::DescriptorTable(DescriptorTable&&) noexcept = default;
DescriptorTable& DescriptorTable::operator=(DescriptorTable&&) noexcept = default;
struct CommandList::Impl {
    enum class State { Initial,
        Recording,
        Executable };
    detail::DeviceState* device;
    State state = State::Initial;
    ComputePipeline::Impl* bound_pipeline = nullptr;
    bool table_bound = false;
    bool constants_bound = false;
    bool pending = false;
    std::unique_ptr<detail::BackendCommands> commands;

    void recording() const { require(state == State::Recording, "GPU command list is not recording"); }
};
namespace detail {
struct FenceState {
    uint64_t submitted_value = 0;
    uint64_t completed_value = 0;
    DeviceState* device;
    QueueState* queue = nullptr;
    std::unique_ptr<BackendFence> fence;
};
struct QueueState {
    struct Submission {
        uint64_t sequence;
        uint64_t value;
        FenceState* fence;
        CommandList::Impl* commands;
    };
    DeviceState* device;
    uint64_t sequence = 0;
    std::deque<Submission> pending;
    std::unique_ptr<BackendQueue> queue;

    void retire(uint64_t completed) {
        while (!pending.empty() && pending.front().sequence <= completed) {
            auto& submission = pending.front();
            submission.fence->completed_value = std::max(submission.fence->completed_value, submission.value);
            submission.commands->pending = false;
            pending.pop_front();
        }
    }
    uint64_t poll(FenceState* fence) {
        fence->completed_value = std::max(fence->completed_value, fence->fence->completed_value());
        uint64_t completed = 0;
        for (const auto& submission : pending) {
            if (submission.fence == fence && submission.value <= fence->completed_value) {
                completed = submission.sequence;
            }
        }
        retire(completed);
        return fence->completed_value;
    }
    void wait_cpu(FenceState* fence, uint64_t value) {
        if (value > fence->completed_value) {
            queue->wait_cpu(*fence->fence, value);
            poll(fence);
        }
    }
    void wait_cpu() {
        if (!pending.empty()) {
            queue->wait_cpu();
            retire(sequence);
        }
    }
};
} // namespace detail
CommandList::CommandList() = default;
CommandList::~CommandList() = default;
CommandList::CommandList(CommandList&&) noexcept = default;
CommandList& CommandList::operator=(CommandList&&) noexcept = default;
void CommandList::reset() {
    require(bool(impl_), "GPU command list is empty");
    require(!impl_->pending, "GPU command list is pending; call wait_cpu on its queue before resetting");
    impl_->commands->reset();
    impl_->bound_pipeline = nullptr;
    impl_->table_bound = false;
    impl_->constants_bound = false;
    impl_->state = Impl::State::Initial;
}
void CommandList::begin() {
    require(bool(impl_), "GPU command list is empty");
    require(!impl_->pending, "GPU command list is pending; call wait_cpu on its queue before recording");
    require(impl_->state == Impl::State::Initial, "GPU command list must be explicitly reset before recording again");
    impl_->commands->begin();
    impl_->state = Impl::State::Recording;
}
void CommandList::copy(const Buffer& source, const Buffer& destination, size_t size, size_t source_offset, size_t destination_offset) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    require(source.impl_ && destination.impl_, "GPU copy requires valid buffers");
    require(source.impl_->state == impl_->device && destination.impl_->state == impl_->device, "GPU copy mixes devices");
    require(source.impl_->memory != BufferMemory::Readback && destination.impl_->memory != BufferMemory::Upload, "GPU copy uses an incompatible transfer buffer");
    check_range(source.size(), source_offset, size);
    check_range(destination.size(), destination_offset, size);
    check_transfer(source_offset, size);
    check_transfer(destination_offset, size);
    require(source.impl_ != destination.impl_ || source_offset + size <= destination_offset || destination_offset + size <= source_offset,
        "GPU copy ranges overlap");
    impl_->commands->copy({ source.impl_->resource.get(), source_offset, size }, { destination.impl_->resource.get(), destination_offset, size });
}
void CommandList::fill(const Buffer& buffer, uint32_t value, size_t size, size_t offset) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    require(buffer.impl_ && buffer.impl_->state == impl_->device, "GPU fill requires a buffer from this device");
    require(buffer.impl_->memory == BufferMemory::Device, "GPU fill requires device storage");
    check_range(buffer.size(), offset, size);
    if (!size) {
        size = buffer.size() - offset;
    }
    check_transfer(offset, size);
    impl_->commands->fill({ buffer.impl_->resource.get(), offset, size }, value);
}
void CommandList::bind_pipeline(const ComputePipeline& pipeline) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    require(pipeline.impl_ && pipeline.impl_->state == impl_->device, "GPU binding requires a pipeline from this device");
    impl_->commands->bind_pipeline(*pipeline.impl_->resource);
    impl_->bound_pipeline = pipeline.impl_.get();
    impl_->table_bound = pipeline.impl_->bindings.empty();
    impl_->constants_bound = pipeline.impl_->push_constant_bytes == 0;
}
void CommandList::bind_descriptor_table(const DescriptorTable& table) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    const auto* pipeline = impl_->bound_pipeline;
    require(bool(pipeline), "GPU descriptor table binding requires a bound pipeline");
    require(table.impl_ && table.impl_->state == impl_->device, "GPU descriptor table binding requires a table from this device");
    require(table.impl_->bindings == pipeline->bindings, "GPU descriptor table layout differs from the pipeline");
    impl_->commands->bind_descriptor_table(*table.impl_->resource);
    impl_->table_bound = true;
}
void CommandList::push_constants(std::span<const std::byte> push) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    require(bool(impl_->bound_pipeline), "GPU push constants require a bound pipeline");
    require(push.size() == impl_->bound_pipeline->push_constant_bytes, "GPU push constant size differs from the pipeline");
    impl_->commands->push_constants(push);
    impl_->constants_bound = true;
}
void CommandList::dispatch(std::array<uint32_t, 3> groups) {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    require(impl_->bound_pipeline && impl_->table_bound && impl_->constants_bound, "GPU dispatch requires a pipeline, descriptor table and push constants");
    for (size_t axis = 0; axis < 3; ++axis) {
        require(groups[axis] <= impl_->device->limits.workgroup_count[axis], "GPU dispatch exceeds device workgroup limits");
    }
    if (std::ranges::find(groups, 0) == groups.end()) {
        impl_->commands->dispatch(groups);
    }
}
void CommandList::end() {
    require(bool(impl_), "GPU command list is empty");
    impl_->recording();
    impl_->commands->end();
    impl_->state = Impl::State::Executable;
}
Fence::Fence() = default;
Fence::~Fence() = default;
Fence::Fence(Fence&&) noexcept = default;
Fence& Fence::operator=(Fence&&) noexcept = default;
uint64_t Fence::completed_value() const {
    require(bool(state_), "GPU fence is empty");
    if (state_->queue) {
        return state_->queue->poll(state_.get());
    }
    return state_->completed_value;
}
Queue::Queue() = default;
Queue::~Queue() = default;
uint64_t Queue::submit(CommandList& commands, Fence& fence) const {
    require(bool(state_), "GPU queue is empty");
    require(commands.impl_ && commands.impl_->state == CommandList::Impl::State::Executable, "GPU command list must be ended before submission");
    require(commands.impl_->device == state_->device && fence.state_ && fence.state_->device == state_->device,
        "GPU queue submission requires commands and a fence from this device");
    require(!commands.impl_->pending, "GPU command list is already pending");
    require(fence.state_->submitted_value != UINT64_MAX, "GPU fence completion values exhausted");
    require(!fence.state_->queue || fence.state_->queue == state_.get(), "GPU fence must be signaled by a single queue");
    require(state_->sequence != UINT64_MAX, "GPU queue submission sequence exhausted");
    const uint64_t value = fence.state_->submitted_value + 1;
    state_->pending.push_back({ state_->sequence + 1, value, fence.state_.get(), commands.impl_.get() });
    try {
        state_->queue->submit(*commands.impl_->commands, *fence.state_->fence, value);
    } catch (...) {
        state_->pending.pop_back();
        throw;
    }
    ++state_->sequence;
    fence.state_->submitted_value = value;
    fence.state_->queue = state_.get();
    commands.impl_->pending = true;
    return value;
}
void Queue::wait_cpu(const Fence& fence, uint64_t value) const {
    require(state_ && fence.state_ && fence.state_->device == state_->device, "CPU wait requires a fence from this device");
    require(value <= fence.state_->submitted_value, "CPU wait value is not covered by the fence's initial value or a submission");
    if (value > fence.state_->completed_value) {
        require(fence.state_->queue == state_.get(), "CPU wait requires a fence submitted to this queue");
        state_->wait_cpu(fence.state_.get(), value);
    }
}
void Queue::wait_cpu() const {
    require(bool(state_), "GPU queue is empty");
    state_->wait_cpu();
}
ComputeDevice::ComputeDevice() : state_(&detail::context()) {}
detail::DeviceState& ComputeDevice::state() const { return *state_; }
const ComputeLimits& ComputeDevice::limits() const { return state().limits; }
size_t ComputeDevice::available_memory() const { return state().backend->available_memory(); }
size_t ComputeDevice::allocation_bytes() const { return state().backend->allocation_bytes(); }
size_t ComputeDevice::linear_item_limit(uint32_t group_size) const {
    require(group_size && group_size <= limits().workgroup_size[0] && group_size <= limits().workgroup_invocations,
        "GPU linear workgroup size exceeds device limits");
    const uint64_t x = std::min<uint64_t>(limits().workgroup_count[0], UINT32_MAX / group_size);
    const uint64_t y = std::min<uint64_t>(limits().workgroup_count[1], UINT32_MAX / (x * group_size));
    return size_t(x * y * group_size);
}
std::array<uint32_t, 3> ComputeDevice::linear_groups(size_t count, uint32_t group_size) const {
    require(count <= linear_item_limit(group_size), "GPU linear dispatch exceeds device limits");
    if (!count) {
        return { 0, 1, 1 };
    }
    const size_t groups = 1 + (count - 1) / group_size;
    const size_t x = std::min<size_t>(groups, limits().workgroup_count[0]);
    return { uint32_t(x), uint32_t(1 + (groups - 1) / x), 1 };
}
Buffer ComputeDevice::create_buffer(size_t size, BufferMemory memory, bool within_budget) const {
    require(size && (memory != BufferMemory::Device || size <= limits().storage_buffer_bytes), "GPU buffer size exceeds device limits or is zero");
    require(memory == BufferMemory::Upload || memory == BufferMemory::Readback || memory == BufferMemory::Device, "Invalid GPU buffer memory type");
    Buffer buffer;
    buffer.impl_ = std::make_unique<Buffer::Impl>(&state(), size, memory, state().backend->create_buffer(size, memory, within_budget));
    return buffer;
}
ComputePipeline ComputeDevice::create_pipeline(const ComputeShader& shader) const {
    require(shader.bindings.size() <= limits().storage_buffer_bindings, "GPU pipeline exceeds device binding limits");
    for (const auto access : shader.bindings) {
        require(access == BufferAccess::Read || access == BufferAccess::ReadWrite, "Invalid GPU buffer access type");
    }
    require(shader.push_constant_bytes <= limits().push_constant_bytes && shader.push_constant_bytes % 4 == 0,
        "GPU pipeline push constants exceed device size or alignment limits");
    require(!shader.entry_point.empty() && shader.entry_point.find('\0') == std::string::npos, "Invalid GPU shader entry point");
    const auto code = shader.code.bytes;
    require(!code.empty(), "Shader asset does not contain a binary for the selected GPU backend");
    std::vector<uint32_t> constant_ids;
    constant_ids.reserve(shader.constants.size());
    for (const auto& constant : shader.constants) {
        constant_ids.push_back(constant.id);
    }
    std::ranges::sort(constant_ids);
    for (size_t i = 1; i < constant_ids.size(); ++i) {
        require(constant_ids[i - 1] != constant_ids[i], "GPU specialization constant IDs must be unique");
    }
    ComputePipeline pipeline;
    pipeline.impl_ = std::make_unique<ComputePipeline::Impl>(&state(), shader.bindings, shader.push_constant_bytes, state().backend->create_pipeline(shader));
    return pipeline;
}
DescriptorTable ComputeDevice::create_descriptor_table(const ComputePipeline& pipeline, std::span<const BufferRange> buffers) const {
    require(pipeline.impl_ && pipeline.impl_->state == &state(), "GPU descriptor table requires a pipeline from this device");
    require(buffers.size() == pipeline.impl_->bindings.size(), "GPU descriptor table binding count differs from the pipeline");
    std::vector<detail::BackendRange> ranges;
    ranges.reserve(buffers.size());
    for (const auto& binding : buffers) {
        require(binding.buffer && binding.buffer->impl_ && binding.buffer->impl_->state == &state(), "GPU descriptor table mixes devices or contains an empty buffer");
        const auto& buffer = *binding.buffer;
        require(buffer.impl_->memory == BufferMemory::Device, "GPU descriptor table requires device storage buffers");
        check_range(buffer.size(), binding.offset, binding.size);
        const size_t size = binding.size ? binding.size : buffer.size() - binding.offset;
        require(size && size <= limits().storage_buffer_bytes && binding.offset % limits().buffer_offset_alignment == 0,
            "GPU descriptor buffer exceeds device range or alignment limits");
        ranges.push_back({ buffer.impl_->resource.get(), binding.offset, size });
    }
    DescriptorTable table;
    table.impl_ = std::make_unique<DescriptorTable::Impl>(&state(), pipeline.impl_->bindings,
        state().backend->create_descriptor_table(*pipeline.impl_->resource, ranges));
    return table;
}
CommandList ComputeDevice::create_commands() const {
    CommandList list;
    list.impl_ = std::make_unique<CommandList::Impl>();
    list.impl_->device = &state();
    list.impl_->commands = state().backend->create_commands();
    return list;
}
Queue& ComputeDevice::default_queue() const {
    auto& device = state();
    if (!device.queue) {
        auto queue = std::make_unique<Queue>();
        queue->state_ = std::make_unique<detail::QueueState>();
        queue->state_->device = &device;
        queue->state_->queue = device.backend->create_queue();
        device.queue = std::move(queue);
    }
    return *device.queue;
}
Fence ComputeDevice::create_fence(uint64_t initial_value) const {
    Fence result;
    result.state_ = std::make_unique<detail::FenceState>();
    result.state_->device = &state();
    result.state_->fence = state().backend->create_fence(initial_value);
    result.state_->submitted_value = initial_value;
    result.state_->completed_value = initial_value;
    return result;
}
} // namespace splat_transform::gpu
