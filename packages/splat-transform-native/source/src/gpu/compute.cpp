#include <vulkan/vulkan_raii.hpp>
#define VMA_IMPLEMENTATION
#include "candidate_count.h"
#include "candidate_scatter.h"
#include "cluster.h"
#include "cluster_schedule.h"
#include "compact.h"
#include "dilate.h"
#include "expand.h"
#include "voxelize.h"
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <deque>
#include <gpu/compute.h>
#include <iomanip>
#include <map>
#include <memory>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <utility/logger.h>
#include <vk_mem_alloc.h>

namespace splat_transform::gpu {
namespace vulkan {
namespace {
struct Binding {
    std::span<const std::byte> bytes;
    size_t size;
    std::span<std::byte> output {};
    bool reuse = false;
    bool clear = true;
};
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
class AllocationFailure : public std::runtime_error {
public:
    explicit AllocationFailure(VkResult result) : std::runtime_error("Vulkan allocation failed: " + std::to_string(result)) {}
};
class Buffer {
public:
    Buffer(VmaAllocator allocator, size_t size, vk::BufferUsageFlags usage, bool host = false, bool within_budget = false) : allocator_(allocator), size_(std::max<size_t>(4, size)) {
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
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;
    ~Buffer() { vmaDestroyBuffer(allocator_, buffer_, allocation_); }
    vk::Buffer handle() const { return vk::Buffer(buffer_); }
    size_t size() const { return size_; }
    std::byte* mapped_data() const {
        if (!info_.pMappedData) {
            throw std::runtime_error("Vulkan buffer is not mapped");
        }
        return static_cast<std::byte*>(info_.pMappedData);
    }
    void flush() {
        if (vmaFlushAllocation(allocator_, allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
            throw std::runtime_error("Vulkan upload flush failed");
        }
    }
    void read_into(std::span<std::byte> output, size_t offset = 0) {
        if (!info_.pMappedData || offset > size_ || output.size() > size_ - offset) {
            throw std::runtime_error("Invalid Vulkan readback range");
        }
        if (vmaInvalidateAllocation(allocator_, allocation_, 0, VK_WHOLE_SIZE) != VK_SUCCESS) {
            throw std::runtime_error("Vulkan readback invalidate failed");
        }
        std::memcpy(output.data(), mapped_data() + offset, output.size());
    }
    void upload(std::span<const std::byte> data) {
        if (!info_.pMappedData || data.size() > size_) {
            throw std::runtime_error("Invalid Vulkan upload");
        }
        std::memcpy(info_.pMappedData, data.data(), data.size());
        flush();
    }

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
    explicit ComputeContext(uint32_t index) : instance_(create_instance(context_)) {
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
    ~ComputeContext() {
        try {
            if (*device_) {
                device_.waitIdle();
            }
        } catch (...) {
        }
    }
    const vk::PhysicalDeviceLimits& limits() const { return limits_; }
    size_t storage_limit() const { return storage_limit_; }
    size_t linear_item_limit() const {
        const uint64_t x = std::min<uint64_t>(limits_.maxComputeWorkGroupCount[0], UINT32_MAX / 128);
        const uint64_t y = std::min<uint64_t>(limits_.maxComputeWorkGroupCount[1], UINT32_MAX / (x * 128));
        return size_t(x * y * 128);
    }
    std::array<uint32_t, 3> linear_groups(size_t count) const {
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
    struct Stage {
        std::string name;
        std::span<const uint8_t> spirv;
        std::vector<uint32_t> bindings;
        std::span<const std::byte> push;
        std::array<uint32_t, 3> groups;
        uint32_t specialization = 0;
    };
    void execute(const std::string& name, std::span<const uint8_t> spirv, const std::vector<Binding>& bindings,
        std::span<const std::byte> push, std::array<uint32_t, 3> groups, uint32_t specialization = 0) {
        std::vector<uint32_t> slots(bindings.size());
        std::iota(slots.begin(), slots.end(), 0);
        execute_chain(bindings, { { name, spirv, std::move(slots), push, groups, specialization } });
    }
    void execute_chain(const std::vector<Binding>& bindings, const std::vector<Stage>& stages) {
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

    Kernel& get_kernel(const Stage& stage) {
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

private:
    friend class ClusterWork;
    vk::raii::Context context_;
    vk::raii::Instance instance_ { nullptr };
    vk::raii::PhysicalDevice physical_ { nullptr };
    vk::raii::Device device_ { nullptr };
    std::unique_ptr<VmaAllocator_T, decltype(&vmaDestroyAllocator)> allocator_ { nullptr, vmaDestroyAllocator };
    vk::raii::Queue queue_ { nullptr };
    vk::raii::CommandPool command_pool_ { nullptr };
    std::map<std::string, std::unique_ptr<Kernel>> kernels_;
    // Synchronous fence completion makes these allocations reusable by the next dispatch.
    std::vector<std::unique_ptr<Buffer>> storage_;
    std::vector<std::unique_ptr<Buffer>> uploads_;
    std::vector<std::unique_ptr<Buffer>> downloads_;
    vk::PhysicalDeviceLimits limits_;
    uint32_t family_ = 0;
    size_t storage_limit_ = 0;
    bool memory_budget_ = false;
};
class ClusterWork {
public:
    ClusterWork(std::shared_ptr<ComputeContext> context, spatial::FeatureView points, size_t centroid_count)
        : context_(std::move(context)), points_(points), columns_(points.dimensions()), rows_(points.rows()), centroid_count_(centroid_count), stride_((columns_ + 3) / 4 * 4) {
        if (!rows_ || !columns_ || !centroid_count_ || centroid_count_ > UINT32_MAX) {
            throw std::runtime_error("Invalid GPU clustering dimensions");
        }
        // The generic executor is synchronous; its scratch allocations are idle here.
        context_->storage_.clear();
        context_->uploads_.clear();
        context_->downloads_.clear();
        const size_t centroid_bytes = centroid_count_ * stride_ * sizeof(float);
        if (centroid_bytes > context_->storage_limit()) {
            throw std::runtime_error("Clustering centroid table exceeds the storage buffer limit");
        }
        size_t tile = 128;
        while (tile * (stride_ * sizeof(float) + sizeof(float)) > context_->limits_.maxComputeSharedMemorySize && tile > 1) {
            tile /= 2;
        }
        const auto variant = std::ranges::find_if(shaders::cluster_variants, [&](const auto& shader) {
            return shader.columns == stride_ / 4 && shader.tile == tile;
        });
        if (variant == shaders::cluster_variants.end()) {
            throw std::runtime_error("Unsupported GPU clustering shader dimensions");
        }
        const std::array<uint32_t, 2> parameters { 0, uint32_t(centroid_count_) };
        kernel_ = &context_->get_kernel({ std::string(variant->name), variant->spirv, { 0, 1, 2, 3 }, std::as_bytes(std::span(parameters)), {} });
        size_t budget = memory_budget();
        for (;;) {
            plan(budget);
            try {
                allocate();
                break;
            } catch (const AllocationFailure&) {
                clear();
                if (budget <= 32 * 1024 * 1024) {
                    throw;
                }
                budget = std::max<size_t>(32 * 1024 * 1024, budget / 2);
            }
        }
        upload_cached_points();
        record_centroids();
        for (size_t i = 0; i < cached_.size(); ++i) {
            record(*cached_[i], i * schedule_.batch_rows, false);
        }
        const auto batches = (rows_ + schedule_.batch_rows - 1) / schedule_.batch_rows;
        const auto concurrency = std::min<size_t>(2, schedule_.cached_batches + schedule_.streaming_slots);
        utility::logger().info("GPU k-means kernel bootstrapped with batch ", (schedule_.batch_rows + 127) / 128,
            "*128*", batches, ", concurrency: ", concurrency, ", runs: ", (batches + concurrency - 1) / concurrency);
    }
    ~ClusterWork() {
        try {
            context_->device_.waitIdle();
        } catch (...) {
        }
    }
    std::vector<uint32_t> assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids) {
        if (static_cast<size_t>(centroids.cols()) != columns_) {
            throw std::runtime_error("GPU centroid column count differs");
        }
        if (static_cast<size_t>(centroids.rows()) != centroid_count_) {
            throw std::runtime_error("GPU centroid count differs");
        }
        auto* packed = reinterpret_cast<float*>(centroid_upload_->mapped_data());
        auto* norms = reinterpret_cast<float*>(norm_upload_->mapped_data());
        for (size_t row = 0; row < centroid_count_; ++row) {
            float norm = 0;
            for (size_t c = 0; c < columns_; ++c) {
                const auto value = centroids(row, c);
                packed[row * stride_ + c] = value;
                norm += float(value) * value;
            }
            std::fill(packed + row * stride_ + columns_, packed + (row + 1) * stride_, 0.0f);
            norms[row] = norm;
        }
        centroid_upload_->flush();
        norm_upload_->flush();
        vk::SubmitInfo upload;
        upload.setCommandBuffers(*centroid_command_);
        context_->queue_.submit(upload, nullptr);
        std::vector<uint32_t> labels(rows_);
        std::deque<Slot*> pending;
        auto retire = [&] {
            auto* slot = pending.front();
            pending.pop_front();
            if (context_->device_.waitForFences(*slot->fence, true, UINT64_MAX) != vk::Result::eSuccess) {
                throw std::runtime_error("GPU clustering submission failed");
            }
            slot->readback->read_into(std::as_writable_bytes(std::span(labels).subspan(slot->start, slot->count)));
        };
        const size_t batches = (rows_ + schedule_.batch_rows - 1) / schedule_.batch_rows;
        for (size_t batch = 0; batch < batches; ++batch) {
            // Two submissions keep transfer/CPU packing ahead without unbounded queueing.
            if (pending.size() == 2) {
                retire();
            }
            Slot* slot;
            if (batch < cached_.size()) {
                slot = cached_[batch].get();
            } else {
                slot = streaming_[(batch - cached_.size()) % streaming_.size()].get();
                if (!pending.empty() && pending.front() == slot) {
                    retire();
                }
                pack_points(*slot->upload, batch * schedule_.batch_rows);
                record(*slot, batch * schedule_.batch_rows, true);
            }
            context_->device_.resetFences(*slot->fence);
            vk::SubmitInfo submit;
            submit.setCommandBuffers(*slot->command);
            context_->queue_.submit(submit, *slot->fence);
            pending.push_back(slot);
        }
        while (!pending.empty()) {
            retire();
        }
        return labels;
    }

private:
    struct Slot {
        std::unique_ptr<Buffer> points;
        std::unique_ptr<Buffer> labels;
        std::unique_ptr<Buffer> upload;
        std::unique_ptr<Buffer> readback;
        vk::raii::DescriptorSet descriptors { nullptr };
        vk::raii::CommandBuffer command { nullptr };
        vk::raii::Fence fence { nullptr };
        size_t start = 0;
        size_t count = 0;
        bool recorded = false;
    };
    size_t memory_budget() {
        std::array<VmaBudget, VK_MAX_MEMORY_HEAPS> budgets;
        vmaGetHeapBudgets(context_->allocator_.get(), budgets.data());
        const auto properties = context_->physical_.getMemoryProperties();
        uint64_t available = 0;
        for (uint32_t i = 0; i < properties.memoryHeapCount; ++i) {
            if (properties.memoryHeaps[i].flags & vk::MemoryHeapFlagBits::eDeviceLocal) {
                available = std::max(available, budgets[i].budget > budgets[i].usage ? budgets[i].budget - budgets[i].usage : uint64_t(0));
            }
        }
        // Cache as much of the input as the available budget permits.
        return size_t(available);
    }
    void plan(size_t budget) {
        schedule_ = cluster_schedule(rows_, centroid_count_, stride_,
            { context_->storage_limit(), context_->limits_.maxComputeWorkGroupCount[0], budget });
    }
    std::unique_ptr<Buffer> buffer(size_t bytes, bool host = false) {
        const auto usage = vk::BufferUsageFlagBits::eTransferSrc | vk::BufferUsageFlagBits::eTransferDst |
                           (host ? vk::BufferUsageFlags {} : vk::BufferUsageFlagBits::eStorageBuffer);
        return std::make_unique<Buffer>(context_->allocator_.get(), bytes, usage, host, !host);
    }
    vk::raii::CommandBuffer command_buffer() {
        auto commands = context_->device_.allocateCommandBuffers(vk::CommandBufferAllocateInfo(*context_->command_pool_, vk::CommandBufferLevel::ePrimary, 1));
        return std::move(commands.front());
    }
    void allocate() {
        centroids_ = buffer(centroid_count_ * stride_ * sizeof(float));
        norms_ = buffer(centroid_count_ * sizeof(float));
        centroid_upload_ = buffer(centroids_->size(), true);
        norm_upload_ = buffer(norms_->size(), true);
        const auto count = uint32_t(schedule_.cached_batches + schedule_.streaming_slots);
        const vk::DescriptorPoolSize pool_size(vk::DescriptorType::eStorageBuffer, count * 4);
        descriptor_pool_ = context_->device_.createDescriptorPool(vk::DescriptorPoolCreateInfo(vk::DescriptorPoolCreateFlagBits::eFreeDescriptorSet, count, pool_size));
        auto create_slot = [&](bool streaming) {
            auto slot = std::make_unique<Slot>();
            slot->points = buffer(schedule_.batch_rows * stride_ * sizeof(float));
            slot->labels = buffer(schedule_.batch_rows * sizeof(uint32_t));
            slot->readback = buffer(slot->labels->size(), true);
            if (streaming) {
                slot->upload = buffer(slot->points->size(), true);
            }
            auto sets = context_->device_.allocateDescriptorSets(vk::DescriptorSetAllocateInfo(*descriptor_pool_, *kernel_->descriptors));
            slot->descriptors = std::move(sets.front());
            const std::array<vk::DescriptorBufferInfo, 4> infos { vk::DescriptorBufferInfo(slot->points->handle(), 0, slot->points->size()),
                vk::DescriptorBufferInfo(centroids_->handle(), 0, centroids_->size()), vk::DescriptorBufferInfo(norms_->handle(), 0, norms_->size()),
                vk::DescriptorBufferInfo(slot->labels->handle(), 0, slot->labels->size()) };
            std::array<vk::WriteDescriptorSet, 4> writes;
            for (uint32_t i = 0; i < 4; ++i) {
                writes[i] = vk::WriteDescriptorSet(*slot->descriptors, i, 0, 1, vk::DescriptorType::eStorageBuffer, nullptr, &infos[i]);
            }
            context_->device_.updateDescriptorSets(writes, nullptr);
            slot->command = command_buffer();
            slot->fence = context_->device_.createFence({});
            return slot;
        };
        for (size_t i = 0; i < schedule_.cached_batches; ++i) {
            cached_.push_back(create_slot(false));
        }
        for (size_t i = 0; i < schedule_.streaming_slots; ++i) {
            streaming_.push_back(create_slot(true));
        }
        centroid_command_ = command_buffer();
        if (!cached_.empty()) {
            initial_upload_ = buffer(schedule_.batch_rows * stride_ * sizeof(float), true);
        }
    }
    void clear() {
        cached_.clear();
        streaming_.clear();
        descriptor_pool_ = nullptr;
        centroids_.reset();
        norms_.reset();
        centroid_upload_.reset();
        norm_upload_.reset();
        initial_upload_.reset();
        centroid_command_ = nullptr;
    }
    void pack_points(Buffer& upload, size_t start) {
        auto* packed = reinterpret_cast<float*>(upload.mapped_data());
        const auto count = std::min(schedule_.batch_rows, rows_ - start);
        for (size_t row = 0; row < count; ++row) {
            for (size_t c = 0; c < columns_; ++c) {
                packed[row * stride_ + c] = points_(start + row, c);
            }
            std::fill(packed + row * stride_ + columns_, packed + (row + 1) * stride_, 0.0f);
        }
        upload.flush();
    }
    void upload_cached_points() {
        if (cached_.empty()) {
            return;
        }
        auto command = command_buffer();
        auto fence = context_->device_.createFence({});
        for (size_t batch = 0; batch < cached_.size(); ++batch) {
            pack_points(*initial_upload_, batch * schedule_.batch_rows);
            command.reset();
            context_->device_.resetFences(*fence);
            command.begin(vk::CommandBufferBeginInfo(vk::CommandBufferUsageFlagBits::eOneTimeSubmit));
            const size_t count = std::min(schedule_.batch_rows, rows_ - batch * schedule_.batch_rows);
            command.copyBuffer(initial_upload_->handle(), cached_[batch]->points->handle(), vk::BufferCopy(0, 0, count * stride_ * sizeof(float)));
            vk::MemoryBarrier ready(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eShaderRead);
            command.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eComputeShader, {}, ready, nullptr, nullptr);
            command.end();
            vk::SubmitInfo submit;
            submit.setCommandBuffers(*command);
            context_->queue_.submit(submit, *fence);
            if (context_->device_.waitForFences(*fence, true, UINT64_MAX) != vk::Result::eSuccess) {
                throw std::runtime_error("GPU clustering point upload failed");
            }
        }
        initial_upload_.reset();
    }
    void record_centroids() {
        centroid_command_.begin({});
        centroid_command_.copyBuffer(centroid_upload_->handle(), centroids_->handle(), vk::BufferCopy(0, 0, centroids_->size()));
        centroid_command_.copyBuffer(norm_upload_->handle(), norms_->handle(), vk::BufferCopy(0, 0, norms_->size()));
        vk::MemoryBarrier ready(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eShaderRead);
        centroid_command_.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eComputeShader, {}, ready, nullptr, nullptr);
        centroid_command_.end();
    }
    void record(Slot& slot, size_t start, bool upload) {
        slot.start = start;
        slot.count = std::min(schedule_.batch_rows, rows_ - start);
        if (slot.recorded) {
            slot.command.reset();
        }
        slot.command.begin({});
        if (upload) {
            slot.command.copyBuffer(slot.upload->handle(), slot.points->handle(), vk::BufferCopy(0, 0, slot.count * stride_ * sizeof(float)));
            vk::MemoryBarrier ready(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eShaderRead);
            slot.command.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eComputeShader, {}, ready, nullptr, nullptr);
        }
        slot.command.bindPipeline(vk::PipelineBindPoint::eCompute, *kernel_->pipeline);
        slot.command.bindDescriptorSets(vk::PipelineBindPoint::eCompute, *kernel_->layout, 0, *slot.descriptors, nullptr);
        const std::array<uint32_t, 2> parameters { uint32_t(slot.count), uint32_t(centroid_count_) };
        slot.command.pushConstants<uint32_t>(*kernel_->layout, vk::ShaderStageFlagBits::eCompute, 0, parameters);
        slot.command.dispatch(uint32_t((slot.count + 127) / 128), 1, 1);
        vk::MemoryBarrier readback(vk::AccessFlagBits::eShaderWrite, vk::AccessFlagBits::eTransferRead);
        slot.command.pipelineBarrier(vk::PipelineStageFlagBits::eComputeShader, vk::PipelineStageFlagBits::eTransfer, {}, readback, nullptr, nullptr);
        slot.command.copyBuffer(slot.labels->handle(), slot.readback->handle(), vk::BufferCopy(0, 0, slot.count * sizeof(uint32_t)));
        vk::MemoryBarrier host(vk::AccessFlagBits::eTransferWrite, vk::AccessFlagBits::eHostRead);
        slot.command.pipelineBarrier(vk::PipelineStageFlagBits::eTransfer, vk::PipelineStageFlagBits::eHost, {}, host, nullptr, nullptr);
        slot.command.end();
        slot.recorded = true;
    }
    std::shared_ptr<ComputeContext> context_;
    spatial::FeatureView points_;
    size_t columns_;
    size_t rows_;
    size_t centroid_count_;
    size_t stride_;
    ClusterSchedule schedule_ {};
    Kernel* kernel_ = nullptr;
    vk::raii::DescriptorPool descriptor_pool_ { nullptr };
    std::unique_ptr<Buffer> centroids_, norms_, centroid_upload_, norm_upload_, initial_upload_;
    std::vector<std::unique_ptr<Slot>> cached_, streaming_;
    vk::raii::CommandBuffer centroid_command_ { nullptr };
};
uint32_t selected_device = 0;
std::shared_ptr<ComputeContext> shared_context;
ComputeContext& context() {
    if (!shared_context) {
        shared_context = std::make_shared<ComputeContext>(selected_device);
    }
    return *shared_context;
}
} // namespace
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
void release_device() { vulkan::shared_context.reset(); }
struct ClusterSession::Impl {
    std::unique_ptr<vulkan::ClusterWork> work;
};
ClusterSession::ClusterSession(spatial::FeatureView points, size_t centroid_count) : impl_(std::make_unique<Impl>()) {
    vulkan::context();
    impl_->work = std::make_unique<vulkan::ClusterWork>(vulkan::shared_context, points, centroid_count);
}
ClusterSession::~ClusterSession() = default;
std::vector<uint32_t> ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids) { return impl_->work->assign(centroids); }
std::vector<uint32_t> voxelize(std::span<const Gaussian> gaussians, std::span<const uint32_t> indices, std::span<const VoxelBatch> batches,
    float resolution, float cutoff, uint32_t max_blocks) {
    if (batches.empty()) {
        return {};
    }
    if (!max_blocks) {
        throw std::runtime_error("Voxel dispatch must contain at least one block");
    }
    struct Parameters {
        float resolution;
        float cutoff;
        uint32_t max_blocks;
        uint32_t accumulation;
        uint32_t first_block;
    };
    static_assert(sizeof(Parameters) == 20);
    auto& context = vulkan::context();
    const size_t storage = context.storage_limit();
    const size_t words = batches.size() * max_blocks * 2;
    std::vector<uint32_t> output(words);
    const auto execute = [&](std::span<const Gaussian> points, std::span<const uint32_t> local_indices, std::span<const VoxelBatch> local_batches,
                             Parameters parameters, std::span<const std::byte> previous, std::span<uint32_t> result, bool reuse_inputs = false) {
        const uint64_t end_block = uint64_t(parameters.first_block) + parameters.max_blocks;
        const bool padded = std::ranges::any_of(local_batches, [&](const auto& batch) {
            return uint64_t(batch.blocks_x) * batch.blocks_y * batch.blocks_z < end_block;
        });
        context.execute("voxelize", vulkan::shaders::voxelize,
            { { std::as_bytes(points), 0, {}, reuse_inputs }, { std::as_bytes(local_indices), 0, {}, reuse_inputs }, { std::as_bytes(local_batches), 0 }, { previous, result.size_bytes(), std::as_writable_bytes(result), false, padded } },
            std::as_bytes(std::span(&parameters, 1)), { parameters.max_blocks, 1, uint32_t(local_batches.size()) }, parameters.accumulation || parameters.first_block ? 1 : 0);
    };
    if (gaussians.size_bytes() <= storage && indices.size_bytes() <= storage && batches.size_bytes() <= storage &&
        words <= storage / 4 && max_blocks <= context.limits().maxComputeWorkGroupCount[0] && batches.size() <= context.limits().maxComputeWorkGroupCount[2]) {
        execute(gaussians, indices, batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, output);
        return output;
    }

    const size_t point_limit = storage / sizeof(Gaussian);
    const size_t batch_limit = std::min({ storage / sizeof(VoxelBatch), storage / (size_t(max_blocks) * 8), size_t(context.limits().maxComputeWorkGroupCount[2]) });
    const size_t block_limit = std::min<size_t>(storage / (64 * 4), context.limits().maxComputeWorkGroupCount[0]);
    if (!point_limit || !block_limit) {
        throw std::runtime_error("Vulkan limits cannot hold one voxel workgroup");
    }
    // When only the dispatch/output needs splitting, keep the original input
    // buffers resident instead of duplicating candidates into packed arrays.
    if (gaussians.size_bytes() <= storage && indices.size_bytes() <= storage && batch_limit && max_blocks <= context.limits().maxComputeWorkGroupCount[0]) {
        for (size_t begin = 0; begin < batches.size(); begin += batch_limit) {
            const auto local_batches = batches.subspan(begin, std::min(batch_limit, batches.size() - begin));
            const size_t local_words = local_batches.size() * max_blocks * 2;
            execute(gaussians, indices, local_batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, std::span(output).subspan(begin * max_blocks * 2, local_words), begin != 0);
        }
        return output;
    }
    std::vector<Gaussian> packed;
    std::vector<uint32_t> local_indices;
    std::vector<VoxelBatch> local_batches;
    const auto pack = [&](const VoxelBatch& batch, size_t begin, size_t count) {
        if (uint64_t(batch.index_offset) + batch.index_count > indices.size()) {
            throw std::runtime_error("Voxel batch references unavailable candidate indices");
        }
        for (size_t i = 0; i < count; ++i) {
            const auto index = indices[size_t(batch.index_offset) + begin + i];
            if (index >= gaussians.size()) {
                throw std::runtime_error("Voxel candidate references an unavailable Gaussian");
            }
            local_indices.push_back(uint32_t(packed.size()));
            packed.push_back(gaussians[index]);
        }
    };
    for (size_t begin = 0; begin < batches.size();) {
        packed.clear();
        local_indices.clear();
        local_batches.clear();
        // Compact only the candidates referenced by this dispatch. Unrelated
        // Gaussians need not fit in a device buffer, even for a large scene.
        if (max_blocks <= context.limits().maxComputeWorkGroupCount[0]) {
            for (size_t i = begin; i < batches.size() && local_batches.size() < batch_limit; ++i) {
                const auto& batch = batches[i];
                if (batch.index_count > point_limit - packed.size()) {
                    break;
                }
                auto local = batch;
                local.index_offset = uint32_t(packed.size());
                pack(batch, 0, batch.index_count);
                local_batches.push_back(local);
            }
        }
        if (!local_batches.empty()) {
            const size_t local_words = local_batches.size() * max_blocks * 2;
            execute(packed, local_indices, local_batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, std::span(output).subspan(begin * max_blocks * 2, local_words));
            begin += local_batches.size();
            continue;
        }

        // A single dense batch can also exceed the Gaussian buffer limit.
        // Carry float densities between chunks and threshold only the final
        // chunk, preserving candidate order and the shader's saturation rule.
        const auto& batch = batches[begin];
        for (size_t block = 0; block < max_blocks; block += block_limit) {
            const auto block_count = uint32_t(std::min<size_t>(block_limit, max_blocks - block));
            std::vector<uint32_t> state;
            for (size_t point = 0; point < std::max<size_t>(batch.index_count, 1); point += point_limit) {
                const size_t count = std::min<size_t>(point_limit, batch.index_count - point);
                const bool last = point + count == batch.index_count;
                const uint32_t accumulation = (point ? 1u : 0u) | (last ? 0u : 2u);
                packed.clear();
                local_indices.clear();
                pack(batch, point, count);
                auto local = batch;
                local.index_offset = 0;
                local.index_count = uint32_t(count);
                const size_t stride = accumulation ? 64 : 2;
                state.resize(size_t(block_count) * stride);
                execute(packed, local_indices, std::span(&local, 1),
                    { resolution, cutoff, block_count, accumulation, uint32_t(block) }, point ? std::as_bytes(std::span(state)) : std::span<const std::byte> {}, state);
                if (last) {
                    for (size_t i = 0; i < block_count; ++i) {
                        std::copy_n(state.data() + i * stride, 2, output.data() + (begin * max_blocks + block + i) * 2);
                    }
                }
            }
        }
        ++begin;
    }
    return output;
}
CandidateBins candidates(std::span<const Gaussian> gaussians, std::array<float, 3> origin, float batch_size, std::array<uint32_t, 3> dimensions) {
    const uint64_t plane = uint64_t(dimensions[0]) * dimensions[1];
    if ((dimensions[2] && plane > UINT32_MAX / dimensions[2]) || gaussians.size() > UINT32_MAX) {
        throw std::runtime_error("Voxel candidate grid exceeds 32-bit indexing");
    }
    const size_t bin_count = size_t(plane * dimensions[2]);
    CandidateBins output;
    output.counts.resize(size_t(bin_count));
    output.offsets.resize(size_t(bin_count));
    if (gaussians.empty() || !bin_count) {
        return output;
    }
    struct Parameters {
        std::array<float, 3> origin;
        float size;
        std::array<uint32_t, 3> dimensions;
        uint32_t count;
        uint32_t groups_x;
        uint32_t first_bin;
        uint32_t bin_count;
        uint32_t first_point;
    };
    auto& context = vulkan::context();
    const size_t point_limit = std::min(context.storage_limit() / sizeof(Gaussian), context.linear_item_limit());
    const size_t index_limit = context.storage_limit() / sizeof(uint32_t);
    if (!point_limit || !index_limit) {
        throw std::runtime_error("Vulkan limits cannot hold one voxel candidate");
    }
    bool split_full_input = false;
    if (gaussians.size() <= point_limit && bin_count <= index_limit) {
        // Preserve the one-dispatch path on devices with a large buffer range.
        // Count and scatter share the same uploaded Gaussian buffer.
        const auto groups = context.linear_groups(gaussians.size());
        const Parameters parameters { origin, batch_size, dimensions, uint32_t(gaussians.size()), groups[0], 0, uint32_t(bin_count), 0 };
        const auto push = std::as_bytes(std::span(&parameters, 1));
        context.execute("candidate_count", vulkan::shaders::candidate_count,
            { { std::as_bytes(gaussians), 0 }, { {}, bin_count * 4, std::as_writable_bytes(std::span(output.counts)) } }, push, groups);
        uint64_t total = 0;
        for (size_t i = 0; i < bin_count; ++i) {
            output.offsets[i] = uint32_t(total);
            total += output.counts[i];
            if (total > UINT32_MAX) {
                throw std::runtime_error("Voxel candidates exceed 32-bit indexing");
            }
        }
        if (!total) {
            return output;
        }
        if (total <= index_limit) {
            output.indices.resize(size_t(total));
            context.execute("candidate_scatter", vulkan::shaders::candidate_scatter,
                { { std::as_bytes(gaussians), 0, {}, true }, { std::as_bytes(std::span(output.offsets)), 0 }, { {}, bin_count * 4 }, { {}, size_t(total) * 4, std::as_writable_bytes(std::span(output.indices)), false, false } }, push, groups);
            return output;
        }
        split_full_input = true;
        std::fill(output.counts.begin(), output.counts.end(), 0);
    }
    struct Range {
        uint32_t bin;
        uint32_t offset;
        uint32_t count;
    };
    struct Part {
        std::vector<Range> ranges;
        std::vector<uint32_t> indices;
    };
    std::vector<Part> parts;
    uint64_t total_indices = 0;
    const auto process = [&](auto&& self, size_t first_point, size_t point_count, size_t first_bin, size_t bins) -> void {
        const auto points = gaussians.subspan(first_point, point_count);
        const auto groups = context.linear_groups(point_count);
        const Parameters parameters { origin, batch_size, dimensions, uint32_t(point_count), groups[0], uint32_t(first_bin), uint32_t(bins), uint32_t(first_point) };
        static_assert(sizeof(Parameters) == 48);
        const uint32_t windowed = first_bin || bins != bin_count ? 1 : 0;
        const auto push = std::as_bytes(std::span(&parameters, 1));
        std::vector<uint32_t> counts(bins);
        context.execute("candidate_count", vulkan::shaders::candidate_count,
            { { std::as_bytes(points), 0 }, { {}, bins * 4, std::as_writable_bytes(std::span(counts)) } }, push, groups, windowed);
        const uint64_t total = std::accumulate(counts.begin(), counts.end(), uint64_t(0));
        if (!total) {
            return;
        }
        if (total > index_limit) {
            // Overlap can make scatter output larger than either input. Split
            // again using the measured count, including the one-point case.
            std::vector<uint32_t>().swap(counts);
            if (point_count > 1) {
                const size_t half = point_count / 2;
                self(self, first_point, half, first_bin, bins);
                self(self, first_point + half, point_count - half, first_bin, bins);
            } else {
                const size_t half = bins / 2;
                self(self, first_point, point_count, first_bin, half);
                self(self, first_point, point_count, first_bin + half, bins - half);
            }
            return;
        }
        total_indices += total;
        if (total_indices > UINT32_MAX) {
            throw std::runtime_error("Voxel candidates exceed 32-bit indexing");
        }
        Part part;
        uint32_t offset = 0;
        for (size_t i = 0; i < bins; ++i) {
            const auto count = counts[i];
            counts[i] = offset;
            if (count) {
                part.ranges.push_back({ uint32_t(first_bin + i), offset, count });
                output.counts[first_bin + i] += count;
                offset += count;
            }
        }
        part.indices.resize(size_t(total));
        context.execute("candidate_scatter", vulkan::shaders::candidate_scatter,
            { { std::as_bytes(points), 0, {}, true }, { std::as_bytes(std::span(counts)), 0 }, { {}, bins * 4 }, { {}, size_t(total) * 4, std::as_writable_bytes(std::span(part.indices)), false, false } }, push, groups, windowed | (first_point ? 2 : 0));
        parts.push_back(std::move(part));
    };
    if (split_full_input) {
        const size_t half = gaussians.size() / 2;
        process(process, 0, half, 0, bin_count);
        process(process, half, gaussians.size() - half, 0, bin_count);
    } else {
        for (size_t bin = 0; bin < bin_count; bin += index_limit) {
            for (size_t point = 0; point < gaussians.size(); point += point_limit) {
                process(process, point, std::min(point_limit, gaussians.size() - point), bin, std::min(index_limit, bin_count - bin));
            }
        }
    }
    uint32_t offset = 0;
    for (size_t i = 0; i < output.counts.size(); ++i) {
        output.offsets[i] = offset;
        offset += output.counts[i];
    }
    if (parts.size() == 1) {
        output.indices = std::move(parts.front().indices);
    } else {
        output.indices.resize(size_t(total_indices));
        for (auto& part : parts) {
            for (const auto& range : part.ranges) {
                std::copy_n(part.indices.data() + range.offset, range.count, output.indices.data() + output.offsets[range.bin]);
                output.offsets[range.bin] += range.count;
            }
            std::vector<uint32_t>().swap(part.indices);
        }
        for (size_t i = 0; i < bin_count; ++i) {
            output.offsets[i] -= output.counts[i];
        }
    }
    return output;
}
std::vector<uint32_t> dilate_blocks(std::span<const uint32_t> blocks, std::array<uint32_t, 3> dimensions, std::array<uint32_t, 3> radii) {
    if (std::ranges::any_of(dimensions, [](uint32_t size) { return !size || size % 4; }) || blocks.size() % 3) {
        throw std::runtime_error("Invalid GPU dilation grid or packed blocks");
    }
    const uint64_t plane = uint64_t(dimensions[0]) * dimensions[1];
    if (plane > UINT32_MAX / dimensions[2]) {
        throw std::runtime_error("GPU dilation grid exceeds 32-bit indexing");
    }
    const uint64_t cells = plane * dimensions[2], block_count = cells / 64;
    const size_t dense_bytes = size_t((cells + 31) / 32) * 4;
    auto& context = vulkan::context();
    for (size_t axis = 0; axis < 3; ++axis) {
        radii[axis] = std::min(radii[axis], dimensions[axis] - 1);
    }
    const auto execute = [&](std::span<const uint32_t> packed, std::array<uint32_t, 3> size) {
        const size_t count = size_t(size[0]) * size[1] * size[2] / 64;
        const size_t bytes = count * 8;
        const auto expand_groups = context.linear_groups(packed.size() / 3);
        const auto compact_groups = context.linear_groups(count);
        const auto dilate_groups = context.linear_groups(bytes / 4);
        std::array<uint32_t, 5> expand { size[0], size[1], size[2], uint32_t(packed.size() / 3), expand_groups[0] };
        std::array<uint32_t, 5> compact { size[0], size[1], size[2], uint32_t(count), compact_groups[0] };
        std::array<std::array<uint32_t, 7>, 3> dilation;
        std::vector<vulkan::ComputeContext::Stage> stages;
        stages.push_back({ "expand", vulkan::shaders::expand, { 0, 1 }, std::as_bytes(std::span(expand)), expand_groups });
        uint32_t current = 1, next = 2;
        for (size_t axis = 0; axis < 3; ++axis) {
            if (radii[axis]) {
                dilation[axis] = { size[0], size[1], size[2], 0, 0, 0, dilate_groups[0] };
                dilation[axis][3 + axis] = std::min(radii[axis], size[axis] - 1);
                stages.push_back({ "dilate", vulkan::shaders::dilate, { current, next }, std::as_bytes(std::span(dilation[axis])), dilate_groups });
                std::swap(current, next);
            }
        }
        stages.push_back({ "compact", vulkan::shaders::compact, { current, 3 }, std::as_bytes(std::span(compact)), compact_groups });
        std::vector<uint32_t> output(count * 2);
        context.execute_chain({ { std::as_bytes(packed), 0 }, { {}, bytes }, { {}, bytes, {}, false, false }, { {}, count * 8, std::as_writable_bytes(std::span(output)), false, false } }, stages);
        return output;
    };
    if (blocks.size_bytes() <= context.storage_limit() && dense_bytes <= context.storage_limit() &&
        blocks.size() / 3 <= context.linear_item_limit() && dense_bytes / 4 <= context.linear_item_limit()) {
        return execute(blocks, dimensions);
    }

    std::array<uint32_t, 3> grid { dimensions[0] / 4, dimensions[1] / 4, dimensions[2] / 4 };
    std::array<uint32_t, 3> minimum = grid, maximum {};
    std::vector<uint32_t> source(size_t(block_count) * 2);
    std::vector<uint32_t> output(source.size());
    for (size_t i = 0; i < blocks.size(); i += 3) {
        const auto index = blocks[i];
        if (index >= block_count) {
            throw std::runtime_error("GPU dilation references an unavailable block");
        }
        if (!(blocks[i + 1] | blocks[i + 2])) {
            continue;
        }
        source[size_t(index) * 2] |= blocks[i + 1];
        source[size_t(index) * 2 + 1] |= blocks[i + 2];
        const std::array<uint32_t, 3> point { index % grid[0], index / grid[0] % grid[1], index / (grid[0] * grid[1]) };
        for (size_t axis = 0; axis < 3; ++axis) {
            minimum[axis] = std::min(minimum[axis], point[axis]);
            maximum[axis] = std::max(maximum[axis], point[axis] + 1);
        }
    }
    if (!maximum[0]) {
        return output;
    }
    std::array<uint32_t, 3> halo, tile;
    for (size_t axis = 0; axis < 3; ++axis) {
        halo[axis] = (radii[axis] + 3) / 4;
        minimum[axis] -= std::min(minimum[axis], halo[axis]);
        maximum[axis] = std::min(grid[axis], maximum[axis] + halo[axis]);
        tile[axis] = maximum[axis] - minimum[axis];
    }
    // Reserve enough space for even a fully occupied tile's packed input.
    // Halos provide all neighbors for the three separable dilation passes.
    const size_t tile_limit = std::min(context.storage_limit() / 12, context.linear_item_limit() / 2);
    const auto padded_count = [&] {
        uint64_t count = 1;
        for (size_t axis = 0; axis < 3; ++axis) {
            count *= std::min(grid[axis], tile[axis] + 2 * halo[axis]);
        }
        return count;
    };
    while (padded_count() > tile_limit) {
        const auto largest = std::max_element(tile.begin(), tile.end());
        if (*largest <= 1) {
            throw std::runtime_error("Vulkan storage limit cannot hold the dilation neighborhood");
        }
        *largest = (*largest + 1) / 2;
    }
    std::vector<uint32_t> packed;
    for (uint32_t z = minimum[2]; z < maximum[2]; z += tile[2]) {
        for (uint32_t y = minimum[1]; y < maximum[1]; y += tile[1]) {
            for (uint32_t x = minimum[0]; x < maximum[0]; x += tile[0]) {
                const std::array<uint32_t, 3> begin { x, y, z };
                std::array<uint32_t, 3> end, low, high, size;
                for (size_t axis = 0; axis < 3; ++axis) {
                    end[axis] = std::min(maximum[axis], begin[axis] + tile[axis]);
                    low[axis] = begin[axis] - std::min(begin[axis], halo[axis]);
                    high[axis] = std::min(grid[axis], end[axis] + halo[axis]);
                    size[axis] = high[axis] - low[axis];
                }
                packed.clear();
                for (uint32_t iz = low[2]; iz < high[2]; ++iz) {
                    for (uint32_t iy = low[1]; iy < high[1]; ++iy) {
                        for (uint32_t ix = low[0]; ix < high[0]; ++ix) {
                            const size_t index = size_t(ix) + size_t(iy) * grid[0] + size_t(iz) * grid[0] * grid[1];
                            if (source[index * 2] | source[index * 2 + 1]) {
                                const uint32_t local = ix - low[0] + (iy - low[1]) * size[0] + (iz - low[2]) * size[0] * size[1];
                                packed.insert(packed.end(), { local, source[index * 2], source[index * 2 + 1] });
                            }
                        }
                    }
                }
                if (packed.empty()) {
                    continue;
                }
                const auto masks = execute(packed, { size[0] * 4, size[1] * 4, size[2] * 4 });
                for (uint32_t iz = begin[2]; iz < end[2]; ++iz) {
                    for (uint32_t iy = begin[1]; iy < end[1]; ++iy) {
                        const size_t global = size_t(begin[0]) + size_t(iy) * grid[0] + size_t(iz) * grid[0] * grid[1];
                        const size_t local = begin[0] - low[0] + size_t(iy - low[1]) * size[0] + size_t(iz - low[2]) * size[0] * size[1];
                        std::copy_n(masks.data() + local * 2, size_t(end[0] - begin[0]) * 2, output.data() + global * 2);
                    }
                }
            }
        }
    }
    return output;
}
} // namespace splat_transform::gpu
