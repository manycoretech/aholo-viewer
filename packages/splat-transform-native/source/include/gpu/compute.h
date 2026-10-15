#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <spatial/features.h>
#include <string>
#include <vector>

namespace splat_transform::gpu {
struct DeviceInfo {
    uint32_t index;
    std::string name;
    uint32_t vendor_id;
    uint32_t device_id;
    uint32_t api_version;
    std::string uuid;
};
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

std::vector<DeviceInfo> enumerate_devices();
void select_device(uint32_t index);
void release_device();
class ClusterSession {
public:
    ClusterSession(spatial::FeatureView points, size_t centroid_count);
    ~ClusterSession();
    ClusterSession(const ClusterSession&) = delete;
    ClusterSession& operator=(const ClusterSession&) = delete;
    std::vector<uint32_t> assign(const spatial::FeatureMatrix& centroids);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
CandidateBins candidates(std::span<const Gaussian> gaussians, std::array<float, 3> origin, float batch_size, std::array<uint32_t, 3> dimensions);
std::vector<uint32_t> voxelize(std::span<const Gaussian> gaussians, std::span<const uint32_t> indices,
    std::span<const VoxelBatch> batches, float resolution, float cutoff, uint32_t max_blocks);
std::vector<uint32_t> dilate_blocks(std::span<const uint32_t> blocks, std::array<uint32_t, 3> dimensions, std::array<uint32_t, 3> radii);
} // namespace splat_transform::gpu
