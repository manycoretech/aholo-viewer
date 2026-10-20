#define VMA_IMPLEMENTATION
#include "vulkan_context.h"
#include <algorithm>
#include <cstring>
#include <gpu/context.h>
#include <iomanip>
#include <numeric>
#include <sstream>
#include <string_view>
#include <utility/logger.h>
#include <utility>

namespace splat_transform::gpu {
namespace vulkan {
namespace {
vk::raii::Instance create_instance(vk::raii::Context& context) {
    if (context.enumerateInstanceVersion() < VK_API_VERSION_1_1) {
        throw std::runtime_error("Vulkan 1.1 or newer is required");
    }
    std::vector<const char*> extensions;
    vk::InstanceCreateFlags flags {};
    for (const auto& extension : context.enumerateInstanceExtensionProperties()) {
        if (std::string_view(extension.extensionName.data()) == VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME) {
            extensions.push_back(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);
            flags |= vk::InstanceCreateFlagBits::eEnumeratePortabilityKHR;
        }
    }
    vk::ApplicationInfo application("splat-transform", 1, "splat-transform", 1, VK_API_VERSION_1_1);
    vk::InstanceCreateInfo info;
    info.setFlags(flags).setPApplicationInfo(&application).setPEnabledExtensionNames(extensions);
    return context.createInstance(info);
}
DeviceInfo describe(const vk::raii::PhysicalDevice& physical, uint32_t index) {
    const auto properties = physical.getProperties2<vk::PhysicalDeviceProperties2, vk::PhysicalDeviceIDProperties>();
    const auto& base = properties.get<vk::PhysicalDeviceProperties2>().properties;
    std::ostringstream uuid;
    for (auto byte : properties.get<vk::PhysicalDeviceIDProperties>().deviceUUID) {
        uuid << std::hex << std::setw(2) << std::setfill('0') << unsigned(byte);
    }
    return { index, base.deviceName.data(), base.vendorID, base.deviceID, base.apiVersion, uuid.str() };
}

uint32_t selected_device = 0;
std::shared_ptr<ComputeContext> shared_context;
} // namespace

Buffer::Buffer(VmaAllocator allocator, size_t size, vk::BufferUsageFlags usage, bool host, bool within_budget) : allocator_(allocator), size_(std::max<size_t>(4, size)) {
    VkBufferCreateInfo info { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
    info.size = size_;
    info.usage = static_cast<VkBufferUsageFlags>(usage);
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VmaAllocationCreateInfo allocation {};
    allocation.usage = host ? VMA_MEMORY_USAGE_AUTO_PREFER_HOST : VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE;
    if (host) {
        allocation.flags = VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT;
    }
    if (within_budget) {
        allocation.flags |= VMA_ALLOCATION_CREATE_WITHIN_BUDGET_BIT;
    }
    const auto status = vmaCreateBuffer(allocator_, &info, &allocation, &buffer_, &allocation_, &info_);
    if (status != VK_SUCCESS) {
        throw AllocationFailure(status);
    }
}
Buffer::~Buffer() { vmaDestroyBuffer(allocator_, buffer_, allocation_); }
std::byte* Buffer::mapped_data() const {
    if (!info_.pMappedData) {
        throw std::runtime_error("Vulkan buffer is not mapped");
    }
    return static_cast<std::byte*>(info_.pMappedData);
}
void Buffer::flush() {
    if (vmaFlushAllocation(allocator_, allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
        throw std::runtime_error("Vulkan upload flush failed");
    }
}
void Buffer::read_into(std::span<std::byte> output, size_t offset) {
    if (!info_.pMappedData || offset > size_ || output.size() > size_ - offset) {
        throw std::runtime_error("Invalid Vulkan readback range");
    }
    if (vmaInvalidateAllocation(allocator_, allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
        throw std::runtime_error("Vulkan readback invalidate failed");
    }
    std::memcpy(output.data(), mapped_data() + offset, output.size());
}
void Buffer::upload(std::span<const std::byte> data) {
    if (!info_.pMappedData || data.size() > size_) {
        throw std::runtime_error("Invalid Vulkan upload");
    }
    std::memcpy(info_.pMappedData, data.data(), data.size());
    flush();
}
ComputeContext::ComputeContext(uint32_t index) : instance_(create_instance(context_)) {
    auto devices = instance_.enumeratePhysicalDevices();
    if (index >= devices.size()) {
        throw std::runtime_error("Vulkan device index is unavailable; run list:gpu to select a Vulkan device");
    }
    physical_ = std::move(devices[index]);
    const auto description = describe(physical_, index);
    utility::logger().info("Vulkan device: ", description.name, " vendor=", description.vendor_id, " device=", description.device_id, " uuid=", description.uuid);
    const auto properties = physical_.getProperties2<vk::PhysicalDeviceProperties2, vk::PhysicalDeviceMaintenance3Properties>();
    limits_ = properties.get<vk::PhysicalDeviceProperties2>().properties.limits;
    storage_limit_ = std::min<uint64_t>(limits_.maxStorageBufferRange, properties.get<vk::PhysicalDeviceMaintenance3Properties>().maxMemoryAllocationSize);
    const auto families = physical_.getQueueFamilyProperties();
    auto found = std::find_if(families.begin(), families.end(), [](const auto& family) { return family.queueCount && bool(family.queueFlags & vk::QueueFlagBits::eCompute); });
    if (found == families.end()) {
        throw std::runtime_error("Selected Vulkan device has no compute queue");
    }
    family_ = static_cast<uint32_t>(found - families.begin());
    const float priority = 1;
    vk::DeviceQueueCreateInfo queue_info({}, family_, 1, &priority);
    std::vector<const char*> extensions;
    for (const auto& extension : physical_.enumerateDeviceExtensionProperties()) {
        if (std::string_view(extension.extensionName.data()) == "VK_KHR_portability_subset") {
            extensions.push_back("VK_KHR_portability_subset");
        }
        if (std::string_view(extension.extensionName.data()) == VK_EXT_MEMORY_BUDGET_EXTENSION_NAME) {
            extensions.push_back(VK_EXT_MEMORY_BUDGET_EXTENSION_NAME);
            memory_budget_ = true;
        }
    }
    vk::DeviceCreateInfo info;
    info.setQueueCreateInfos(queue_info).setPEnabledExtensionNames(extensions);
    device_ = physical_.createDevice(info);
    queue_ = device_.getQueue(family_, 0);
    command_pool_ = device_.createCommandPool(vk::CommandPoolCreateInfo(vk::CommandPoolCreateFlagBits::eResetCommandBuffer, family_));
    VmaVulkanFunctions functions {};
    functions.vkGetInstanceProcAddr = context_.getDispatcher()->vkGetInstanceProcAddr;
    functions.vkGetDeviceProcAddr = instance_.getDispatcher()->vkGetDeviceProcAddr;
    VmaAllocatorCreateInfo allocator_info {};
    allocator_info.instance = static_cast<VkInstance>(*instance_);
    allocator_info.physicalDevice = static_cast<VkPhysicalDevice>(*physical_);
    allocator_info.device = static_cast<VkDevice>(*device_);
    allocator_info.vulkanApiVersion = VK_API_VERSION_1_1;
    allocator_info.pVulkanFunctions = &functions;
    if (memory_budget_) {
        allocator_info.flags |= VMA_ALLOCATOR_CREATE_EXT_MEMORY_BUDGET_BIT;
    }
    allocator_info.preferredLargeHeapBlockSize = 64 * 1024 * 1024;
    // VMA resolves the remaining Vulkan entry points through the user-provided loader.
    VmaAllocator allocator;
    if (vmaCreateAllocator(&allocator_info, &allocator) != VK_SUCCESS) {
        throw std::runtime_error("Cannot initialize Vulkan memory allocator");
    }
    allocator_.reset(allocator);
}
ComputeContext::~ComputeContext() {
    try {
        if (*device_) {
            device_.waitIdle();
        }
    } catch (...) {
    }
}
size_t ComputeContext::linear_item_limit() const {
    const uint64_t x = std::min<uint64_t>(limits_.maxComputeWorkGroupCount[0], UINT32_MAX / 128);
    const uint64_t y = std::min<uint64_t>(limits_.maxComputeWorkGroupCount[1], UINT32_MAX / (x * 128));
    return size_t(x * y * 128);
}
std::array<uint32_t, 3> ComputeContext::linear_groups(size_t count) const {
    if (count > linear_item_limit()) {
        throw std::runtime_error("Vulkan linear dispatch exceeds device limits");
    }
    const size_t groups = (count + 127) / 128;
    const size_t x = std::min<size_t>(std::max<size_t>(groups, 1), limits_.maxComputeWorkGroupCount[0]);
    const size_t y = (groups + x - 1) / x;
    if (y > limits_.maxComputeWorkGroupCount[1]) {
        throw std::runtime_error("Vulkan linear dispatch exceeds device limits");
    }
    return { uint32_t(x), uint32_t(y), 1 };
}
void ComputeContext::execute(const std::string& name, std::span<const uint8_t> spirv, const std::vector<Binding>& bindings,
    std::span<const std::byte> push, std::array<uint32_t, 3> groups, uint32_t specialization) {
    std::vector<uint32_t> slots(bindings.size());
    std::iota(slots.begin(), slots.end(), 0);
    execute_chain(bindings, { { name, spirv, std::move(slots), push, groups, specialization } });
}
void ComputeContext::execute_chain(const std::vector<Binding>& bindings, const std::vector<Stage>& stages) {
    storage_.resize(std::max(storage_.size(), bindings.size()));
    uploads_.resize(storage_.size());
    downloads_.resize(storage_.size());
    auto ensure = [&](std::unique_ptr<Buffer>& buffer, size_t size, bool host) {
        if (!buffer || buffer->size() < std::max<size_t>(4, size)) {
            buffer = std::make_unique<Buffer>(allocator_.get(), size, vk::BufferUsageFlagBits::eTransferDst | vk::BufferUsageFlagBits::eTransferSrc | (host ? vk::BufferUsageFlags {} : vk::BufferUsageFlagBits::eStorageBuffer), host);
            return true;
        }
        return false;
    };
    auto commands = device_.allocateCommandBuffers(vk::CommandBufferAllocateInfo(*command_pool_, vk::CommandBufferLevel::ePrimary, 1));
    auto& command = commands.front();
    command.begin(vk::CommandBufferBeginInfo(vk::CommandBufferUsageFlagBits::eOneTimeSubmit));
    std::vector<vk::DescriptorBufferInfo> buffer_infos;
    for (size_t i = 0; i < bindings.size(); ++i) {
        const auto& binding = bindings[i];
        const size_t size = std::max<size_t>(4, std::max(binding.bytes.size(), binding.size));
        if (size > storage_limit_) {
            throw std::runtime_error("Vulkan storage buffer exceeds device limit; reduce batch size");
        }
        if (binding.output.size() > size) {
            throw std::runtime_error("Vulkan readback exceeds the bound buffer range");
        }
        const bool reallocated = ensure(storage_[i], size, false);
        if (!binding.reuse || reallocated) {
            if (!binding.bytes.empty()) {
                ensure(uploads_[i], binding.bytes.size(), true);
                uploads_[i]->upload(binding.bytes);
                command.copyBuffer(uploads_[i]->handle(), storage_[i]->handle(), vk::BufferCopy(0, 0, binding.bytes.size()));
            } else if (binding.clear) {
                command.fillBuffer(storage_[i]->handle(), 0, size, 0);
            }
        }
        buffer_infos.emplace_back(storage_[i]->handle(), 0, size);
    }
    vk::MemoryBarrier upload(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eShaderRead | vk::AccessFlagBits::eShaderWrite);
    command.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eComputeShader, {}, upload, nullptr, nullptr);
    uint32_t descriptor_count = 0;
    for (const auto& stage : stages) {
        descriptor_count += uint32_t(stage.bindings.size());
    }
    vk::DescriptorPoolSize pool_size(vk::DescriptorType::eStorageBuffer, descriptor_count);
    auto pool = device_.createDescriptorPool(vk::DescriptorPoolCreateInfo(vk::DescriptorPoolCreateFlagBits::eFreeDescriptorSet, uint32_t(stages.size()), pool_size));
    std::vector<vk::raii::DescriptorSet> descriptor_sets;
    for (const auto& stage : stages) {
        for (size_t axis = 0; axis < 3; ++axis) {
            if (stage.groups[axis] > limits_.maxComputeWorkGroupCount[axis]) {
                throw std::runtime_error("Vulkan dispatch exceeds device limits");
            }
        }
        if (stage.push.size() > limits_.maxPushConstantsSize) {
            throw std::runtime_error("Vulkan push constants exceed device limit");
        }
        auto& kernel = get_kernel(stage);
        auto sets = device_.allocateDescriptorSets(vk::DescriptorSetAllocateInfo(*pool, *kernel.descriptors));
        descriptor_sets.push_back(std::move(sets.front()));
        std::vector<vk::WriteDescriptorSet> writes;
        for (uint32_t i = 0; i < stage.bindings.size(); ++i) {
            writes.emplace_back(*descriptor_sets.back(), i, 0, 1, vk::DescriptorType::eStorageBuffer, nullptr, &buffer_infos.at(stage.bindings[i]));
        }
        device_.updateDescriptorSets(writes, nullptr);
        command.bindPipeline(vk::PipelineBindPoint::eCompute, *kernel.pipeline);
        command.bindDescriptorSets(vk::PipelineBindPoint::eCompute, *kernel.layout, 0, *descriptor_sets.back(), nullptr);
        command.pushConstants<std::byte>(*kernel.layout, vk::ShaderStageFlagBits::eCompute, 0, stage.push);
        command.dispatch(stage.groups[0], stage.groups[1], stage.groups[2]);
        vk::MemoryBarrier compute(vk::AccessFlagBits::eShaderWrite, vk::AccessFlagBits::eShaderRead | vk::AccessFlagBits::eShaderWrite | vk::AccessFlagBits::eTransferRead);
        command.pipelineBarrier(vk::PipelineStageFlagBits::eComputeShader, vk::PipelineStageFlagBits::eComputeShader | vk::PipelineStageFlagBits::eTransfer, {}, compute, nullptr, nullptr);
    }
    for (size_t i = 0; i < bindings.size(); ++i) {
        if (bindings[i].output.empty()) {
            continue;
        }
        ensure(downloads_[i], bindings[i].output.size(), true);
        command.copyBuffer(storage_[i]->handle(), downloads_[i]->handle(), vk::BufferCopy(0, 0, bindings[i].output.size()));
    }
    vk::MemoryBarrier host(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eHostRead);
    command.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eHost, {}, host, nullptr, nullptr);
    command.end();
    auto fence = device_.createFence({});
    vk::SubmitInfo submit;
    submit.setCommandBuffers(*command);
    queue_.submit(submit, *fence);
    if (device_.waitForFences(*fence, true, UINT64_MAX) != vk::Result::eSuccess) {
        throw std::runtime_error("Vulkan submission failed");
    }
    for (size_t i = 0; i < bindings.size(); ++i) {
        if (!bindings[i].output.empty()) {
            downloads_[i]->read_into(bindings[i].output);
        }
    }
}
Kernel& ComputeContext::get_kernel(const Stage& stage) {
    std::string specialized_name;
    if (stage.specialization) {
        specialized_name = stage.name + ':' + std::to_string(stage.specialization);
    }
    auto& kernel_ptr = kernels_[stage.specialization ? specialized_name : stage.name];
    if (!kernel_ptr) {
        auto kernel = std::make_unique<Kernel>();
        std::vector<vk::DescriptorSetLayoutBinding> layout_bindings;
        for (uint32_t i = 0; i < stage.bindings.size(); ++i) {
            layout_bindings.emplace_back(i, vk::DescriptorType::eStorageBuffer, 1, vk::ShaderStageFlagBits::eCompute);
        }
        kernel->descriptors = device_.createDescriptorSetLayout(vk::DescriptorSetLayoutCreateInfo({}, layout_bindings));
        vk::PushConstantRange range(vk::ShaderStageFlagBits::eCompute, 0, uint32_t(stage.push.size()));
        vk::PipelineLayoutCreateInfo layout_info;
        layout_info.setSetLayouts(*kernel->descriptors).setPushConstantRanges(range);
        kernel->layout = device_.createPipelineLayout(layout_info);
        std::vector<uint32_t> words(stage.spirv.size() / 4);
        std::memcpy(words.data(), stage.spirv.data(), stage.spirv.size());
        kernel->shader = device_.createShaderModule(vk::ShaderModuleCreateInfo({}, stage.spirv.size(), words.data()));
        vk::PipelineShaderStageCreateInfo shader({}, vk::ShaderStageFlagBits::eCompute, *kernel->shader, "main");
        const vk::SpecializationMapEntry entry(0, 0, sizeof(stage.specialization));
        vk::SpecializationInfo specialization;
        if (stage.specialization) {
            specialization.setMapEntries(entry).setDataSize(sizeof(stage.specialization)).setPData(&stage.specialization);
            shader.setPSpecializationInfo(&specialization);
        }
        kernel->pipeline = device_.createComputePipeline(nullptr, vk::ComputePipelineCreateInfo({}, shader, *kernel->layout));
        kernel_ptr = std::move(kernel);
    }
    return *kernel_ptr;
}

std::shared_ptr<ComputeContext> context() {
    if (!shared_context) {
        shared_context = std::make_shared<ComputeContext>(selected_device);
    }
    return shared_context;
}
} // namespace vulkan
std::vector<DeviceInfo> enumerate_devices() {
    vk::raii::Context context;
    auto instance = vulkan::create_instance(context);
    auto physical = instance.enumeratePhysicalDevices();
    std::vector<DeviceInfo> result;
    for (uint32_t i = 0; i < physical.size(); ++i) {
        result.push_back(vulkan::describe(physical[i], i));
    }
    return result;
}
void select_device(uint32_t index) {
    if (index != vulkan::selected_device) {
        vulkan::shared_context.reset();
    }
    vulkan::selected_device = index;
}
DeviceGuard::~DeviceGuard() { vulkan::shared_context.reset(); }
} // namespace splat_transform::gpu
