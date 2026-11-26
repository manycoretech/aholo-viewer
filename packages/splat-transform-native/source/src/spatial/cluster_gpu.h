#pragma once
#include <functional>
#include <gpu/compute.h>
#include <memory>
#include <span>
#include <spatial/features.h>
#include <vector>

namespace splat_transform::spatial {
size_t cluster_tile(const gpu::ComputeDevice& device, size_t stride);
gpu::ComputePipeline make_cluster_pipeline(const gpu::ComputeDevice& device, size_t stride, size_t tile);
void dispatch_cluster(
    gpu::CommandList& commands, const gpu::ComputePipeline& pipeline, const gpu::DescriptorTable& table, uint32_t count,
    uint32_t active, uint32_t point_offset = 0, uint32_t label_offset = 0
);
void pack_cluster_points(
    const gpu::Buffer& upload, FeatureView points, std::span<const uint32_t> order, size_t start, size_t count,
    size_t stride, std::span<const float> weights = {}
);

class ClusterSession {
public:
    ClusterSession(
        spatial::FeatureView points, size_t centroid_count, size_t max_batch_rows = 0,
        std::span<const uint32_t> order = {}
    );
    ~ClusterSession();
    ClusterSession(const ClusterSession&) = delete;
    ClusterSession& operator=(const ClusterSession&) = delete;
    std::vector<uint32_t> assign(
        const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids
    );
    // Reports the ready prefix of labels on the calling thread after each ordered readback.
    // The caller owns labels, including any CPU work started by the callback.
    void assign(
        const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
        std::span<uint32_t> labels, const std::function<void(size_t)>& ready = {}, size_t first = 0
    );

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::spatial
