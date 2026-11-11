#pragma once
#include <gpu/compute.h>
#include <unordered_map>

namespace splat_transform::voxel {
struct BufferData {
    std::span<const std::byte> bytes;
    size_t size = 0;
    std::span<std::byte> output {};
    // Preserve this slot only if its contents are already current. Allocation
    // growth falls back to uploading bytes (or clearing when requested).
    bool reuse = false;
    bool clear = true;
};
struct ComputeStage {
    gpu::ComputeShader shader;
    std::vector<uint32_t> bindings;
    std::span<const std::byte> push;
    std::array<uint32_t, 3> groups {};
};
uint64_t pipeline_hash(const gpu::ComputeShader& shader) noexcept;

// Synchronous sequences reuse workspace-owned storage and transfer buffers.
// Shader bytecode must remain immutable and alive for the workspace lifetime.
class GpuWorkspace {
public:
    explicit GpuWorkspace(gpu::ComputeDevice device = {});
    GpuWorkspace(const GpuWorkspace&) = delete;
    GpuWorkspace& operator=(const GpuWorkspace&) = delete;
    GpuWorkspace(GpuWorkspace&&) noexcept = default;
    GpuWorkspace& operator=(GpuWorkspace&&) noexcept = default;
    const gpu::ComputeDevice& device() const { return device_; }
    void execute(const gpu::ComputeShader& shader, const std::vector<BufferData>& bindings,
        std::span<const std::byte> push, std::array<uint32_t, 3> groups);
    void execute_chain(const std::vector<BufferData>& bindings, const std::vector<ComputeStage>& stages);

private:
    const gpu::ComputePipeline& pipeline(const gpu::ComputeShader& shader);
    gpu::ComputeDevice device_;
    std::unordered_map<uint64_t, gpu::ComputePipeline> pipelines_;
    std::vector<gpu::Buffer> storage_, uploads_, downloads_;
};
} // namespace splat_transform::voxel
