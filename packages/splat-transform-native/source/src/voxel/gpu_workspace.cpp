#include "gpu_workspace.h"
#include <algorithm>
#include <numeric>
#include <utility>

namespace splat_transform::voxel {
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
} // namespace
GpuWorkspace::GpuWorkspace(gpu::ComputeDevice device) : device_(device) {}
const gpu::ComputePipeline& GpuWorkspace::pipeline(const gpu::ComputeShader& shader) {
    const auto code = shader.code.bytes;
    PipelineKey key { { code.begin(), code.end() }, shader.bindings, shader.push_constant_bytes, {}, shader.entry_point };
    for (const auto& constant : shader.constants) {
        key.constants.emplace_back(constant.id, constant.value);
    }
    std::ranges::sort(key.constants);
    auto found = pipelines_.find(key);
    if (found == pipelines_.end()) {
        auto resource = device_.create_pipeline(shader);
        found = pipelines_.emplace(std::move(key), std::move(resource)).first;
    }
    return found->second;
}
void GpuWorkspace::execute(const gpu::ComputeShader& shader, const std::vector<BufferData>& bindings,
    std::span<const std::byte> push, std::array<uint32_t, 3> groups) {
    std::vector<uint32_t> slots(bindings.size());
    std::iota(slots.begin(), slots.end(), 0);
    execute_chain(bindings, { { shader, std::move(slots), push, groups } });
}
void GpuWorkspace::execute_chain(const std::vector<BufferData>& bindings, const std::vector<ComputeStage>& stages) {
    if (stages.empty()) {
        require(bindings.empty(), "GPU workspace bindings require at least one compute stage");
        return;
    }
    // Validate all host ranges and stage indices before changing reused storage.
    for (const auto& binding : bindings) {
        const size_t size = std::max<size_t>(4, std::max(binding.bytes.size(), binding.size));
        require(size <= device_.limits().storage_buffer_bytes && size % 4 == 0, "GPU workspace buffer size exceeds device limits or alignment");
        require(binding.output.size() <= size && binding.bytes.size() % 4 == 0 && binding.output.size() % 4 == 0,
            "GPU workspace transfer range exceeds the buffer or is unaligned");
    }
    std::vector<const gpu::ComputePipeline*> pipelines;
    for (const auto& stage : stages) {
        require(stage.bindings.size() == stage.shader.bindings.size() && stage.push.size() == stage.shader.push_constant_bytes,
            "GPU workspace stage differs from its pipeline layout");
        for (const auto slot : stage.bindings) {
            require(slot < bindings.size(), "GPU workspace stage references an unavailable buffer");
        }
        for (size_t axis = 0; axis < 3; ++axis) {
            require(stage.groups[axis] <= device_.limits().workgroup_count[axis], "GPU dispatch exceeds device workgroup limits");
        }
        pipelines.push_back(&pipeline(stage.shader));
    }
    storage_.resize(std::max(storage_.size(), bindings.size()));
    uploads_.resize(storage_.size());
    downloads_.resize(storage_.size());
    auto ensure = [&](gpu::Buffer& buffer, size_t size, gpu::BufferMemory memory) {
        if (!buffer || buffer.size() < size) {
            buffer = device_.create_buffer(size, memory);
            return true;
        }
        return false;
    };
    // The task owns every table until this chain has completed.
    std::vector<gpu::DescriptorTable> tables;
    tables.reserve(stages.size());
    auto commands = device_.create_commands();
    commands.begin();
    std::vector<gpu::BufferRange> ranges;
    for (size_t i = 0; i < bindings.size(); ++i) {
        const auto& binding = bindings[i];
        const size_t size = std::max<size_t>(4, std::max(binding.bytes.size(), binding.size));
        const bool reallocated = ensure(storage_[i], size, gpu::BufferMemory::Device);
        if (!binding.reuse || reallocated) {
            if (!binding.bytes.empty()) {
                ensure(uploads_[i], binding.bytes.size(), gpu::BufferMemory::Upload);
                uploads_[i].upload(binding.bytes);
                commands.copy(uploads_[i], storage_[i], binding.bytes.size());
            } else if (binding.clear) {
                commands.fill(storage_[i], 0, size);
            }
        }
        ranges.push_back({ &storage_[i], 0, size });
    }
    for (size_t i = 0; i < stages.size(); ++i) {
        std::vector<gpu::BufferRange> buffers;
        for (const auto slot : stages[i].bindings) {
            buffers.push_back(ranges[slot]);
        }
        tables.push_back(device_.create_descriptor_table(*pipelines[i], buffers));
        commands.bind_pipeline(*pipelines[i]);
        commands.bind_descriptor_table(tables.back());
        commands.push_constants(stages[i].push);
        commands.dispatch(stages[i].groups);
    }
    for (size_t i = 0; i < bindings.size(); ++i) {
        if (!bindings[i].output.empty()) {
            ensure(downloads_[i], bindings[i].output.size(), gpu::BufferMemory::Readback);
            commands.copy(storage_[i], downloads_[i], bindings[i].output.size());
        }
    }
    commands.end();
    auto& queue = device_.default_queue();
    auto fence = device_.create_fence();
    const auto value = queue.submit(commands, fence);
    try {
        queue.wait_cpu(fence, value);
    } catch (...) {
        // Keep local commands, tables and fence alive during error cleanup.
        try {
            queue.wait_cpu();
        } catch (...) {
        }
        throw;
    }
    for (size_t i = 0; i < bindings.size(); ++i) {
        if (!bindings[i].output.empty()) {
            downloads_[i].read_into(bindings[i].output);
        }
    }
}
} // namespace splat_transform::voxel
