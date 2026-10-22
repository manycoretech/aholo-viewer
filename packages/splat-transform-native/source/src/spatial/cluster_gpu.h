#pragma once
#include <memory>
#include <spatial/features.h>
#include <vector>

namespace splat_transform::spatial {
class ClusterSession {
public:
    ClusterSession(spatial::FeatureView points, size_t centroid_count);
    ~ClusterSession();
    ClusterSession(const ClusterSession&) = delete;
    ClusterSession& operator=(const ClusterSession&) = delete;
    std::vector<uint32_t> assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::spatial
