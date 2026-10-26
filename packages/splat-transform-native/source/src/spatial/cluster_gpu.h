#pragma once
#include <functional>
#include <memory>
#include <span>
#include <spatial/features.h>
#include <vector>

namespace splat_transform::spatial {
class ClusterSession {
public:
    ClusterSession(spatial::FeatureView points, size_t centroid_count, size_t max_batch_rows = 0);
    ~ClusterSession();
    ClusterSession(const ClusterSession&) = delete;
    ClusterSession& operator=(const ClusterSession&) = delete;
    std::vector<uint32_t> assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids);
    // Reports the ready prefix on the calling thread after each ordered readback.
    // The caller owns labels, including any CPU work started by the callback.
    void assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
        std::span<uint32_t> labels, const std::function<void(size_t)>& ready);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::spatial
