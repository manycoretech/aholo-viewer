#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

namespace splat_transform::voxel {
struct Gaussian {
    std::array<float, 16> values {};
};
struct VoxelBatch {
    uint32_t index_offset;
    uint32_t index_count;
    uint32_t blocks_x;
    uint32_t blocks_y;
    uint32_t blocks_z;
    float min_x;
    float min_y;
    float min_z;
};
struct CandidateBins {
    std::vector<uint32_t> counts;
    std::vector<uint32_t> offsets;
    std::vector<uint32_t> indices;
};

// Reuse full-size GPU/transfer buffers throughout one voxel task. Destruction
// releases its buffers and pipeline cache. The enclosing DeviceGuard owns the
// device context and must outlive this session.
class VoxelSession {
public:
    VoxelSession();
    ~VoxelSession();
    VoxelSession(const VoxelSession&) = delete;
    VoxelSession& operator=(const VoxelSession&) = delete;
    CandidateBins candidates(std::span<const Gaussian> gaussians, std::array<float, 3> origin, float batch_size, std::array<uint32_t, 3> dimensions);
    std::vector<uint32_t> voxelize(std::span<const Gaussian> gaussians, std::span<const uint32_t> indices,
        std::span<const VoxelBatch> batches, float resolution, float cutoff, uint32_t max_blocks);
    std::vector<uint32_t> dilate_blocks(std::span<const uint32_t> blocks, std::array<uint32_t, 3> dimensions, std::array<uint32_t, 3> radii);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::voxel
