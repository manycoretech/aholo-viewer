#pragma once
#include "backend.h"
#include <vk_mem_alloc.h>
#include <vulkan/vulkan_raii.hpp>

namespace splat_transform::gpu::vulkan {
class Buffer final : public detail::BackendBuffer {
public:
    Buffer(VmaAllocator allocator, size_t size, BufferMemory memory, bool within_budget);
    ~Buffer() override;
    vk::Buffer handle() const { return vk::Buffer(buffer_); }
    std::byte* mapped_data() override;
    void flush() override;
    void invalidate() override;

private:
    VmaAllocator allocator_;
    VkBuffer buffer_ = VK_NULL_HANDLE;
    VmaAllocation allocation_ {};
    VmaAllocationInfo info_ {};
};
struct Pipeline final : detail::BackendPipeline {
    vk::raii::DescriptorSetLayout descriptors { nullptr };
    vk::raii::PipelineLayout layout { nullptr };
    vk::raii::ShaderModule shader { nullptr };
    vk::raii::Pipeline pipeline { nullptr };
};
class Commands;
class Queue;
class Device final : public detail::BackendDevice {
public:
    explicit Device(uint32_t index);
    ~Device() override;
    ComputeLimits limits() const override;
    size_t available_memory() const override;
    size_t allocation_bytes() const override;
    std::unique_ptr<detail::BackendBuffer> create_buffer(size_t size, BufferMemory memory, bool within_budget) override;
    std::unique_ptr<detail::BackendPipeline> create_pipeline(const ComputeShader& shader) override;
    std::unique_ptr<detail::BackendDescriptorTable> create_descriptor_table(detail::BackendPipeline& pipeline, std::span<const detail::BackendRange> buffers) override;
    std::unique_ptr<detail::BackendCommands> create_commands() override;
    std::unique_ptr<detail::BackendQueue> create_queue() override;
    std::unique_ptr<detail::BackendFence> create_fence(uint64_t initial_value) override;

private:
    friend class Commands;
    friend class Queue;
    vk::raii::Context context_;
    vk::raii::Instance instance_ { nullptr };
    vk::raii::PhysicalDevice physical_ { nullptr };
    vk::raii::Device device_ { nullptr };
    std::unique_ptr<VmaAllocator_T, decltype(&vmaDestroyAllocator)> allocator_ { nullptr, vmaDestroyAllocator };
    vk::raii::Queue queue_ { nullptr };
    vk::PhysicalDeviceLimits limits_;
    uint32_t family_ = 0;
    size_t storage_limit_ = 0;
    uint64_t timeline_max_difference_ = 0;
    bool memory_budget_ = false;
};
} // namespace splat_transform::gpu::vulkan
