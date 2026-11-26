#define VMA_IMPLEMENTATION
#include "vulkan_context.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <gpu/context.h>
#include <iomanip>
#include <limits>
#include <numeric>
#include <sstream>
#include <string_view>
#include <utility/logger.h>
#include <utility>

namespace splat_transform::gpu {
namespace vulkan {
namespace {
vk::raii::Instance create_instance(vk::raii::Context& context) {
    if (context.enumerateInstanceVersion() < VK_API_VERSION_1_2) {
        throw std::runtime_error("Vulkan 1.2 or newer is required");
    }
    std::vector<const char*> extensions;
    vk::InstanceCreateFlags flags {};
    for (const auto& extension : context.enumerateInstanceExtensionProperties()) {
        if (std::string_view(extension.extensionName.data()) == VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME) {
            extensions.push_back(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);
            flags |= vk::InstanceCreateFlagBits::eEnumeratePortabilityKHR;
        }
    }
    vk::ApplicationInfo application("splat-transform", 1, "splat-transform", 1, VK_API_VERSION_1_2);
    vk::InstanceCreateInfo info;
    info.setFlags(flags).setPApplicationInfo(&application).setPEnabledExtensionNames(extensions);
    return context.createInstance(info);
}
DeviceInfo describe(const vk::raii::PhysicalDevice& physical) {
    const auto properties = physical.getProperties2<vk::PhysicalDeviceProperties2, vk::PhysicalDeviceIDProperties>();
    const auto& base = properties.get<vk::PhysicalDeviceProperties2>().properties;
    std::ostringstream uuid;
    for (auto byte : properties.get<vk::PhysicalDeviceIDProperties>().deviceUUID) {
        uuid << std::hex << std::setw(2) << std::setfill('0') << static_cast<uint32_t>(byte);
    }
    return {
        .name = base.deviceName.data(),
        .api = ApiType::Vulkan,
        .api_version = base.apiVersion,
        .vendor_id = base.vendorID,
        .device_id = base.deviceID,
        .uuid = uuid.str()
    };
}

} // namespace

Device::Device(uint32_t index) : instance_(create_instance(this->context_)) {
    auto devices = this->instance_.enumeratePhysicalDevices();
    if (index >= devices.size()) {
        throw std::runtime_error("Vulkan device index is unavailable; run list:gpu to select a Vulkan device");
    }
    this->physical_ = std::move(devices[index]);
    if (this->physical_.getProperties().apiVersion < VK_API_VERSION_1_2) {
        throw std::runtime_error("Selected device must support Vulkan 1.2 or newer");
    }
    const auto description = describe(this->physical_);
    utility::logger().info(
        "Vulkan device: ", description.name, " vendor=", description.vendor_id, " device=", description.device_id,
        " uuid=", description.uuid
    );
    const auto properties =
        this->physical_.getProperties2<vk::PhysicalDeviceProperties2, vk::PhysicalDeviceMaintenance3Properties>();
    this->limits_ = properties.get<vk::PhysicalDeviceProperties2>().properties.limits;
    this->storage_limit_ = std::min<uint64_t>(
        this->limits_.maxStorageBufferRange,
        properties.get<vk::PhysicalDeviceMaintenance3Properties>().maxMemoryAllocationSize
    );
    const auto families = this->physical_.getQueueFamilyProperties();
    auto found = std::find_if(families.begin(), families.end(), [](const auto& family) {
        return family.queueCount && static_cast<bool>(family.queueFlags & vk::QueueFlagBits::eCompute);
    });
    if (found == families.end()) {
        throw std::runtime_error("Selected Vulkan device has no compute queue");
    }
    this->family_ = static_cast<uint32_t>(found - families.begin());
    const float priority = 1;
    vk::DeviceQueueCreateInfo queue_info({}, this->family_, 1, &priority);
    std::vector<const char*> extensions;
    for (const auto& extension : this->physical_.enumerateDeviceExtensionProperties()) {
        if (std::string_view(extension.extensionName.data()) == "VK_KHR_portability_subset") {
            extensions.push_back("VK_KHR_portability_subset");
        }
        if (std::string_view(extension.extensionName.data()) == VK_EXT_MEMORY_BUDGET_EXTENSION_NAME) {
            extensions.push_back(VK_EXT_MEMORY_BUDGET_EXTENSION_NAME);
            this->memory_budget_ = true;
        }
    }
    auto features =
        this->physical_.getFeatures2<vk::PhysicalDeviceFeatures2, vk::PhysicalDeviceTimelineSemaphoreFeatures>();
    auto& timeline = features.get<vk::PhysicalDeviceTimelineSemaphoreFeatures>();
    if (!timeline.timelineSemaphore) {
        throw std::runtime_error("Selected Vulkan device does not support the timelineSemaphore feature");
    }
    const auto timeline_properties =
        this->physical_.getProperties2<vk::PhysicalDeviceProperties2, vk::PhysicalDeviceTimelineSemaphoreProperties>();
    this->timeline_max_difference_ =
        timeline_properties.get<vk::PhysicalDeviceTimelineSemaphoreProperties>().maxTimelineSemaphoreValueDifference;
    vk::DeviceCreateInfo info;
    info.setQueueCreateInfos(queue_info).setPEnabledExtensionNames(extensions).setPNext(&timeline);
    this->device_ = this->physical_.createDevice(info);
    this->queue_ = this->device_.getQueue(this->family_, 0);
    VmaVulkanFunctions functions {};
    functions.vkGetInstanceProcAddr = this->context_.getDispatcher()->vkGetInstanceProcAddr;
    functions.vkGetDeviceProcAddr = this->instance_.getDispatcher()->vkGetDeviceProcAddr;
    VmaAllocatorCreateInfo allocator_info {};
    allocator_info.instance = static_cast<VkInstance>(*this->instance_);
    allocator_info.physicalDevice = static_cast<VkPhysicalDevice>(*this->physical_);
    allocator_info.device = static_cast<VkDevice>(*this->device_);
    allocator_info.vulkanApiVersion = VK_API_VERSION_1_2;
    allocator_info.pVulkanFunctions = &functions;
    if (this->memory_budget_) {
        allocator_info.flags |= VMA_ALLOCATOR_CREATE_EXT_MEMORY_BUDGET_BIT;
    }
    allocator_info.preferredLargeHeapBlockSize = 64 * 1024 * 1024;
    // VMA resolves the remaining Vulkan entry points through the user-provided loader.
    VmaAllocator allocator;
    if (vmaCreateAllocator(&allocator_info, &allocator) != VK_SUCCESS) {
        throw std::runtime_error("Cannot initialize Vulkan memory allocator");
    }
    this->allocator_.reset(allocator);
}
Device::~Device() = default;
ComputeLimits Device::limits() const {
    return { this->storage_limit_, static_cast<size_t>(this->limits_.minStorageBufferOffsetAlignment),
        std::min(this->limits_.maxPerStageDescriptorStorageBuffers, this->limits_.maxDescriptorSetStorageBuffers),
        this->limits_.maxPushConstantsSize, this->limits_.maxComputeSharedMemorySize,
        { this->limits_.maxComputeWorkGroupCount[0], this->limits_.maxComputeWorkGroupCount[1],
            this->limits_.maxComputeWorkGroupCount[2] },
        { this->limits_.maxComputeWorkGroupSize[0], this->limits_.maxComputeWorkGroupSize[1],
            this->limits_.maxComputeWorkGroupSize[2] },
        this->limits_.maxComputeWorkGroupInvocations };
}
size_t Device::available_memory() const {
    std::array<VmaBudget, VK_MAX_MEMORY_HEAPS> budgets;
    vmaGetHeapBudgets(this->allocator_.get(), budgets.data());
    const auto properties = this->physical_.getMemoryProperties();
    uint64_t available = 0;
    for (uint32_t i = 0; i < properties.memoryHeapCount; ++i) {
        if (properties.memoryHeaps[i].flags & vk::MemoryHeapFlagBits::eDeviceLocal) {
            available = std::max(
                available,
                budgets[i].budget > budgets[i].usage ? budgets[i].budget - budgets[i].usage : static_cast<uint64_t>(0)
            );
        }
    }
    return static_cast<size_t>(available);
}
size_t Device::allocation_bytes() const {
    VmaTotalStatistics statistics {};
    vmaCalculateStatistics(this->allocator_.get(), &statistics);
    return statistics.total.statistics.allocationBytes;
}
Buffer::Buffer(VmaAllocator allocator, size_t size, BufferMemory memory, bool within_budget) : allocator_(allocator) {
    VkBufferCreateInfo info { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
    info.size = size;
    info.usage =
        memory == BufferMemory::Device
            ? VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT
        : memory == BufferMemory::Upload ? VK_BUFFER_USAGE_TRANSFER_SRC_BIT
                                         : VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VmaAllocationCreateInfo allocation {};
    allocation.usage =
        memory == BufferMemory::Device ? VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE : VMA_MEMORY_USAGE_AUTO_PREFER_HOST;
    if (memory != BufferMemory::Device) {
        allocation.flags = VMA_ALLOCATION_CREATE_MAPPED_BIT |
                           (memory == BufferMemory::Upload ? VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT
                                                           : VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT);
    }
    if (within_budget) {
        allocation.flags |= VMA_ALLOCATION_CREATE_WITHIN_BUDGET_BIT;
    }
    const auto status =
        vmaCreateBuffer(this->allocator_, &info, &allocation, &this->buffer_, &this->allocation_, &this->info_);
    if (status != VK_SUCCESS) {
        throw AllocationFailure("Vulkan allocation failed: " + std::to_string(status));
    }
}
Buffer::~Buffer() { vmaDestroyBuffer(this->allocator_, this->buffer_, this->allocation_); }
std::byte* Buffer::mapped_data() {
    if (!this->info_.pMappedData) {
        throw std::runtime_error("Vulkan buffer is not mapped");
    }
    return static_cast<std::byte*>(this->info_.pMappedData);
}
void Buffer::flush() {
    if (vmaFlushAllocation(this->allocator_, this->allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
        throw std::runtime_error("Vulkan upload flush failed");
    }
}
void Buffer::invalidate() {
    if (vmaInvalidateAllocation(this->allocator_, this->allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
        throw std::runtime_error("Vulkan readback invalidate failed");
    }
}
std::unique_ptr<detail::BackendBuffer> Device::create_buffer(size_t size, BufferMemory memory, bool within_budget) {
    return std::make_unique<Buffer>(this->allocator_.get(), size, memory, within_budget);
}
std::unique_ptr<detail::BackendPipeline> Device::create_pipeline(const ComputeShader& description) {
    const auto code = description.code.bytes;
    if (code.size() < 20 || code.size() % 4) {
        throw std::runtime_error("Invalid SPIR-V size for " + description.name);
    }
    std::vector<uint32_t> words(code.size() / 4);
    std::memcpy(words.data(), code.data(), code.size());
    if (words.front() != 0x07230203) {
        throw std::runtime_error("Invalid SPIR-V magic for " + description.name);
    }
    auto pipeline = std::make_unique<Pipeline>();
    std::vector<vk::DescriptorSetLayoutBinding> bindings;
    for (uint32_t i = 0; i < description.bindings.size(); ++i) {
        bindings.emplace_back(i, vk::DescriptorType::eStorageBuffer, 1, vk::ShaderStageFlagBits::eCompute);
    }
    vk::PipelineLayoutCreateInfo layout_info;
    if (!bindings.empty()) {
        pipeline->descriptors =
            this->device_.createDescriptorSetLayout(vk::DescriptorSetLayoutCreateInfo({}, bindings));
        layout_info.setSetLayouts(*pipeline->descriptors);
    }
    const vk::PushConstantRange range(vk::ShaderStageFlagBits::eCompute, 0, description.push_constant_bytes);
    if (description.push_constant_bytes) {
        layout_info.setPushConstantRanges(range);
    }
    pipeline->layout = this->device_.createPipelineLayout(layout_info);
    pipeline->shader = this->device_.createShaderModule(vk::ShaderModuleCreateInfo({}, code.size(), words.data()));
    vk::PipelineShaderStageCreateInfo shader(
        {}, vk::ShaderStageFlagBits::eCompute, *pipeline->shader, description.entry_point.c_str()
    );
    std::vector<vk::SpecializationMapEntry> entries;
    std::vector<uint32_t> values;
    for (const auto& constant : description.constants) {
        entries.emplace_back(constant.id, static_cast<uint32_t>(values.size() * sizeof(uint32_t)), sizeof(uint32_t));
        values.push_back(constant.value);
    }
    vk::SpecializationInfo specialization;
    if (!entries.empty()) {
        specialization.setMapEntries(entries).setDataSize(values.size() * sizeof(uint32_t)).setPData(values.data());
        shader.setPSpecializationInfo(&specialization);
    }
    pipeline->pipeline =
        this->device_.createComputePipeline(nullptr, vk::ComputePipelineCreateInfo({}, shader, *pipeline->layout));
    return pipeline;
}
struct DescriptorTable final : detail::BackendDescriptorTable {
    vk::raii::DescriptorPool pool { nullptr };
    vk::raii::DescriptorSet set { nullptr };
};
std::unique_ptr<detail::BackendDescriptorTable> Device::create_descriptor_table(
    detail::BackendPipeline& base, std::span<const detail::BackendRange> buffers
) {
    auto table = std::make_unique<DescriptorTable>();
    if (buffers.empty()) {
        return table;
    }
    const auto& pipeline = static_cast<Pipeline&>(base);
    const vk::DescriptorPoolSize size(vk::DescriptorType::eStorageBuffer, static_cast<uint32_t>(buffers.size()));
    table->pool = this->device_.createDescriptorPool(
        vk::DescriptorPoolCreateInfo(vk::DescriptorPoolCreateFlagBits::eFreeDescriptorSet, 1, size)
    );
    auto sets =
        this->device_.allocateDescriptorSets(vk::DescriptorSetAllocateInfo(*table->pool, *pipeline.descriptors));
    table->set = std::move(sets.front());
    std::vector<vk::DescriptorBufferInfo> infos;
    infos.reserve(buffers.size());
    for (const auto& buffer : buffers) {
        infos.emplace_back(static_cast<Buffer*>(buffer.buffer)->handle(), buffer.offset, buffer.size);
    }
    std::vector<vk::WriteDescriptorSet> writes;
    writes.reserve(infos.size());
    for (uint32_t i = 0; i < infos.size(); ++i) {
        writes.emplace_back(*table->set, i, 0, 1, vk::DescriptorType::eStorageBuffer, nullptr, &infos[i]);
    }
    this->device_.updateDescriptorSets(writes, nullptr);
    return table;
}
class Commands final : public detail::BackendCommands {
public:
    explicit Commands(Device& device) : context_(device) {
        this->pool_ = this->context_.device_.createCommandPool(vk::CommandPoolCreateInfo({}, this->context_.family_));
        auto commands = this->context_.device_.allocateCommandBuffers(
            vk::CommandBufferAllocateInfo(*this->pool_, vk::CommandBufferLevel::ePrimary, 1)
        );
        this->command_ = std::move(commands.front());
    }
    vk::CommandBuffer handle() const { return *this->command_; }
    void reset() override {
        // This pool owns one recording. The HAL rejects resets while pending.
        this->pool_.reset({});
        this->pipeline_ = nullptr;
    }
    void begin() override { this->command_.begin({}); }
    void copy(const detail::BackendRange& source, const detail::BackendRange& destination) override {
        this->barrier(
            vk::PipelineStageFlagBits::eTransfer, vk::AccessFlagBits::eTransferRead | vk::AccessFlagBits::eTransferWrite
        );
        this->command_.copyBuffer(
            static_cast<Buffer*>(source.buffer)->handle(), static_cast<Buffer*>(destination.buffer)->handle(),
            vk::BufferCopy(source.offset, destination.offset, source.size)
        );
    }
    void fill(const detail::BackendRange& buffer, uint32_t value) override {
        this->barrier(vk::PipelineStageFlagBits::eTransfer, vk::AccessFlagBits::eTransferWrite);
        this->command_.fillBuffer(static_cast<Buffer*>(buffer.buffer)->handle(), buffer.offset, buffer.size, value);
    }
    void bind_pipeline(detail::BackendPipeline& base) override {
        this->pipeline_ = &static_cast<Pipeline&>(base);
        this->command_.bindPipeline(vk::PipelineBindPoint::eCompute, *this->pipeline_->pipeline);
    }
    void bind_descriptor_table(detail::BackendDescriptorTable& base) override {
        const auto& table = static_cast<DescriptorTable&>(base);
        if (*table.set) {
            this->command_.bindDescriptorSets(
                vk::PipelineBindPoint::eCompute, *this->pipeline_->layout, 0, *table.set, nullptr
            );
        }
    }
    void push_constants(std::span<const std::byte> push) override {
        if (!push.empty()) {
            this->command_.pushConstants<std::byte>(
                *this->pipeline_->layout, vk::ShaderStageFlagBits::eCompute, 0, push
            );
        }
    }
    void dispatch(std::array<uint32_t, 3> groups) override {
        this->barrier(
            vk::PipelineStageFlagBits::eComputeShader,
            vk::AccessFlagBits::eShaderRead | vk::AccessFlagBits::eShaderWrite
        );
        this->command_.dispatch(groups[0], groups[1], groups[2]);
    }
    void end() override {
        const vk::MemoryBarrier host(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eHostRead);
        this->command_.pipelineBarrier(
            vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eHost, {}, host, nullptr, nullptr
        );
        this->command_.end();
    }

private:
    void barrier(vk::PipelineStageFlags stage, vk::AccessFlags access) {
        // Include reads to cover write-after-read hazards across repeated lists
        // and queue submissions, as well as transfer/compute write visibility.
        const vk::MemoryBarrier dependency(
            vk::AccessFlagBits::eShaderRead | vk::AccessFlagBits::eShaderWrite | vk::AccessFlagBits::eTransferRead |
                vk::AccessFlagBits::eTransferWrite,
            access
        );
        this->command_.pipelineBarrier(
            vk::PipelineStageFlagBits::eComputeShader | vk::PipelineStageFlagBits::eTransfer, stage, {}, dependency,
            nullptr, nullptr
        );
    }
    Device& context_;
    vk::raii::CommandPool pool_ { nullptr };
    vk::raii::CommandBuffer command_ { nullptr };
    Pipeline* pipeline_ = nullptr;
};
class Fence final : public detail::BackendFence {
public:
    Fence(vk::raii::Device& device, uint64_t initial_value) {
        const vk::SemaphoreTypeCreateInfo type(vk::SemaphoreType::eTimeline, initial_value);
        vk::SemaphoreCreateInfo info;
        info.setPNext(&type);
        this->semaphore_ = device.createSemaphore(info);
    }
    vk::Semaphore handle() const { return *this->semaphore_; }
    uint64_t completed_value() const override { return this->semaphore_.getCounterValue(); }

private:
    vk::raii::Semaphore semaphore_ { nullptr };
};
class Queue final : public detail::BackendQueue {
public:
    explicit Queue(Device& device) : context_(device) {}
    void submit(detail::BackendCommands& commands, detail::BackendFence& fence, uint64_t value) override {
        auto& timeline = static_cast<Fence&>(fence);
        const auto completed = timeline.completed_value();
        if (value <= completed || value - completed > this->context_.timeline_max_difference_) {
            throw std::runtime_error("Vulkan fence signal value exceeds the timeline semaphore value range");
        }
        const auto command = static_cast<Commands&>(commands).handle();
        const auto semaphore = timeline.handle();
        vk::TimelineSemaphoreSubmitInfo values;
        values.setSignalSemaphoreValues(value);
        vk::SubmitInfo submit;
        submit.setCommandBuffers(command).setSignalSemaphores(semaphore).setPNext(&values);
        this->context_.queue_.submit(submit, nullptr);
    }
    void wait_cpu(detail::BackendFence& fence, uint64_t value) override {
        const auto semaphore = static_cast<Fence&>(fence).handle();
        const vk::SemaphoreWaitInfo info({}, semaphore, value);
        if (this->context_.device_.waitSemaphores(info, std::numeric_limits<uint64_t>::max()) != vk::Result::eSuccess) {
            throw std::runtime_error("Vulkan timeline semaphore CPU wait failed");
        }
    }
    void wait_cpu() override { this->context_.queue_.waitIdle(); }

private:
    Device& context_;
};
std::unique_ptr<detail::BackendQueue> Device::create_queue() { return std::make_unique<Queue>(*this); }
std::unique_ptr<detail::BackendFence> Device::create_fence(uint64_t initial_value) {
    return std::make_unique<Fence>(this->device_, initial_value);
}
std::unique_ptr<detail::BackendCommands> Device::create_commands() { return std::make_unique<Commands>(*this); }
} // namespace vulkan
namespace detail {
std::unique_ptr<BackendDevice> create_vulkan_device(uint32_t index) { return std::make_unique<vulkan::Device>(index); }
std::vector<DeviceInfo> enumerate_vulkan_devices() {
    vk::raii::Context context;
    auto instance = vulkan::create_instance(context);
    auto physical = instance.enumeratePhysicalDevices();
    std::vector<DeviceInfo> result;
    for (const auto& device : physical) {
        result.push_back(vulkan::describe(device));
    }
    return result;
}
} // namespace detail
} // namespace splat_transform::gpu
