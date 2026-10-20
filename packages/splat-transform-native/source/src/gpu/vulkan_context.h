#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <vk_mem_alloc.h>
#include <vulkan/vulkan_raii.hpp>

namespace splat_transform::gpu::vulkan {
struct Binding {
    std::span<const std::byte> bytes;
    size_t size;
    std::span<std::byte> output {};
    bool reuse = false;
    bool clear = true;
};
class AllocationFailure : public std::runtime_error {
public:
    explicit AllocationFailure(VkResult result) : std::runtime_error("Vulkan allocation failed: " + std::to_string(result)) {}
};
class Buffer {
public:
    Buffer(VmaAllocator allocator, size_t size, vk::BufferUsageFlags usage, bool host = false, bool within_budget = false);
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;
    ~Buffer();
    vk::Buffer handle() const { return vk::Buffer(buffer_); }
    size_t size() const { return size_; }
    std::byte* mapped_data() const;
    void flush();
    void read_into(std::span<std::byte> output, size_t offset = 0);
    void upload(std::span<const std::byte> data);

private:
    VmaAllocator allocator_;
    size_t size_;
    VkBuffer buffer_ = VK_NULL_HANDLE;
    VmaAllocation allocation_ {};
    VmaAllocationInfo info_ {};
};
struct Kernel {
    vk::raii::DescriptorSetLayout descriptors { nullptr };
    vk::raii::PipelineLayout layout { nullptr };
    vk::raii::ShaderModule shader { nullptr };
    vk::raii::Pipeline pipeline { nullptr };
};
class ClusterWork;
class ComputeContext {
public:
    explicit ComputeContext(uint32_t index);
    ~ComputeContext();
    const vk::PhysicalDeviceLimits& limits() const { return limits_; }
    size_t storage_limit() const { return storage_limit_; }
    size_t linear_item_limit() const;
    std::array<uint32_t, 3> linear_groups(size_t count) const;
    struct Stage {
        std::string name;
        std::span<const uint8_t> spirv;
        std::vector<uint32_t> bindings;
        std::span<const std::byte> push;
        std::array<uint32_t, 3> groups;
        uint32_t specialization = 0;
    };
    void execute(const std::string& name, std::span<const uint8_t> spirv, const std::vector<Binding>& bindings,
        std::span<const std::byte> push, std::array<uint32_t, 3> groups, uint32_t specialization = 0);
    void execute_chain(const std::vector<Binding>& bindings, const std::vector<Stage>& stages);
    Kernel& get_kernel(const Stage& stage);

private:
    friend class ClusterWork;
    vk::raii::Context context_;
    vk::raii::Instance instance_ { nullptr };
    vk::raii::PhysicalDevice physical_ { nullptr };
    vk::raii::Device device_ { nullptr };
    std::unique_ptr<VmaAllocator_T, decltype(&vmaDestroyAllocator)> allocator_ { nullptr, vmaDestroyAllocator };
    vk::raii::Queue queue_ { nullptr };
    vk::raii::CommandPool command_pool_ { nullptr };
    std::unordered_map<std::string, std::unique_ptr<Kernel>> kernels_;
    // Synchronous fence completion makes these allocations reusable by the next dispatch.
    std::vector<std::unique_ptr<Buffer>> storage_;
    std::vector<std::unique_ptr<Buffer>> uploads_;
    std::vector<std::unique_ptr<Buffer>> downloads_;
    vk::PhysicalDeviceLimits limits_;
    uint32_t family_ = 0;
    size_t storage_limit_ = 0;
    bool memory_budget_ = false;
};
// Keep the selected context alive for the entire operation or clustering session.
std::shared_ptr<ComputeContext> context();
} // namespace splat_transform::gpu::vulkan
