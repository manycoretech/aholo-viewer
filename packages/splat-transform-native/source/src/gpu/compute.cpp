#include "backend.h"
#include <algorithm>
#include <cstring>
#include <limits>
#include <utility>

namespace splat_transform::gpu {
struct Buffer::Impl {
    size_t size;
    std::unique_ptr<detail::BackendBuffer> resource;
};
Buffer::Buffer() = default;
Buffer::~Buffer() = default;
Buffer::Buffer(Buffer&&) noexcept = default;
Buffer& Buffer::operator=(Buffer&&) noexcept = default;
size_t Buffer::size() const { return this->impl_ ? this->impl_->size : 0; }
std::byte* Buffer::mapped_data() const { return this->impl_->resource->mapped_data(); }
void Buffer::flush() const { this->impl_->resource->flush(); }
void Buffer::upload(std::span<const std::byte> data) const {
    const size_t bytes = std::min(data.size(), this->size());
    if (bytes) {
        std::memcpy(this->mapped_data(), data.data(), bytes);
        this->flush();
    }
}
void Buffer::read_into(std::span<std::byte> output, size_t offset) const {
    const size_t capacity = this->size();
    const size_t bytes = std::min(output.size(), capacity - std::min(offset, capacity));
    if (bytes) {
        this->impl_->resource->invalidate();
        std::memcpy(output.data(), this->impl_->resource->mapped_data() + offset, bytes);
    }
}
ComputePipeline::ComputePipeline() = default;
ComputePipeline::~ComputePipeline() = default;
ComputePipeline::ComputePipeline(ComputePipeline&&) noexcept = default;
ComputePipeline& ComputePipeline::operator=(ComputePipeline&&) noexcept = default;
DescriptorTable::DescriptorTable() = default;
DescriptorTable::~DescriptorTable() = default;
DescriptorTable::DescriptorTable(DescriptorTable&&) noexcept = default;
DescriptorTable& DescriptorTable::operator=(DescriptorTable&&) noexcept = default;
CommandList::CommandList() = default;
CommandList::~CommandList() = default;
CommandList::CommandList(CommandList&&) noexcept = default;
CommandList& CommandList::operator=(CommandList&&) noexcept = default;
void CommandList::reset() { this->impl_->reset(); }
void CommandList::begin() { this->impl_->begin(); }
void CommandList::copy(
    const Buffer& source, const Buffer& destination, size_t size, size_t source_offset, size_t destination_offset
) {
    this->impl_->copy(
        { source.impl_->resource.get(), source_offset, size },
        { destination.impl_->resource.get(), destination_offset, size }
    );
}
void CommandList::fill(const Buffer& buffer, uint32_t value, size_t size, size_t offset) {
    this->impl_->fill({ buffer.impl_->resource.get(), offset, size ? size : buffer.size() - offset }, value);
}
void CommandList::bind_pipeline(const ComputePipeline& pipeline) { this->impl_->bind_pipeline(*pipeline.impl_); }
void CommandList::bind_descriptor_table(const DescriptorTable& table) {
    this->impl_->bind_descriptor_table(*table.impl_);
}
void CommandList::push_constants(std::span<const std::byte> push) { this->impl_->push_constants(push); }
void CommandList::dispatch(std::array<uint32_t, 3> groups) {
    if (std::ranges::find(groups, 0) == groups.end()) {
        this->impl_->dispatch(groups);
    }
}
void CommandList::end() { this->impl_->end(); }

namespace detail {
struct FenceState {
    uint64_t submitted_value;
    std::unique_ptr<BackendFence> fence;
};
} // namespace detail
Fence::Fence() = default;
Fence::~Fence() = default;
Fence::Fence(Fence&&) noexcept = default;
Fence& Fence::operator=(Fence&&) noexcept = default;
uint64_t Fence::completed_value() const { return this->state_->fence->completed_value(); }
Queue::Queue() = default;
Queue::~Queue() = default;
uint64_t Queue::submit(CommandList& commands, Fence& fence) const {
    const uint64_t value = fence.state_->submitted_value + 1;
    this->queue_->submit(*commands.impl_, *fence.state_->fence, value);
    fence.state_->submitted_value = value;
    return value;
}
void Queue::wait_cpu(const Fence& fence, uint64_t value) const { this->queue_->wait_cpu(*fence.state_->fence, value); }
void Queue::wait_cpu() const { this->queue_->wait_cpu(); }
ComputeDevice::ComputeDevice() : state_(&detail::context()) {}
detail::DeviceState& ComputeDevice::state() const { return *this->state_; }
const ComputeLimits& ComputeDevice::limits() const { return this->state().limits; }
size_t ComputeDevice::available_memory() const { return this->state().backend->available_memory(); }
size_t ComputeDevice::allocation_bytes() const { return this->state().backend->allocation_bytes(); }
size_t ComputeDevice::linear_item_limit(uint32_t group_size) const {
    const uint64_t x =
        std::min<uint64_t>(this->limits().workgroup_count[0], std::numeric_limits<uint32_t>::max() / group_size);
    const uint64_t y =
        std::min<uint64_t>(this->limits().workgroup_count[1], std::numeric_limits<uint32_t>::max() / (x * group_size));
    return static_cast<size_t>(x * y * group_size);
}
std::array<uint32_t, 3> ComputeDevice::linear_groups(size_t count, uint32_t group_size) const {
    if (!count) {
        return { 0, 1, 1 };
    }
    const size_t groups = 1 + (count - 1) / group_size;
    const size_t x = std::min<size_t>(groups, this->limits().workgroup_count[0]);
    return { static_cast<uint32_t>(x), static_cast<uint32_t>(1 + (groups - 1) / x), 1 };
}
Buffer ComputeDevice::create_buffer(size_t size, BufferMemory memory, bool within_budget) const {
    Buffer buffer;
    buffer.impl_ =
        std::make_unique<Buffer::Impl>(size, this->state().backend->create_buffer(size, memory, within_budget));
    return buffer;
}
ComputePipeline ComputeDevice::create_pipeline(const ComputeShader& shader) const {
    ComputePipeline pipeline;
    pipeline.impl_ = this->state().backend->create_pipeline(shader);
    return pipeline;
}
DescriptorTable ComputeDevice::create_descriptor_table(
    const ComputePipeline& pipeline, std::span<const BufferRange> buffers
) const {
    std::vector<detail::BackendRange> ranges;
    ranges.reserve(buffers.size());
    for (const auto& binding : buffers) {
        const auto& buffer = *binding.buffer->impl_;
        ranges.push_back(
            { buffer.resource.get(), binding.offset, binding.size ? binding.size : buffer.size - binding.offset }
        );
    }
    DescriptorTable table;
    table.impl_ = this->state().backend->create_descriptor_table(*pipeline.impl_, ranges);
    return table;
}
CommandList ComputeDevice::create_commands() const {
    CommandList list;
    list.impl_ = this->state().backend->create_commands();
    return list;
}
Queue& ComputeDevice::default_queue() const {
    auto& device = this->state();
    if (!device.queue) {
        auto queue = std::make_unique<Queue>();
        queue->queue_ = device.backend->create_queue();
        device.queue = std::move(queue);
    }
    return *device.queue;
}
Fence ComputeDevice::create_fence(uint64_t initial_value) const {
    Fence result;
    result.state_ =
        std::make_unique<detail::FenceState>(initial_value, this->state().backend->create_fence(initial_value));
    return result;
}
} // namespace splat_transform::gpu
