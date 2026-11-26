#pragma once
#include <memory>
#include <spatial/clustering.h>

namespace splat_transform::spatial {
class EmeansGpu {
public:
    using Split = std::array<uint32_t, 2>;
    using SplitSelector = std::vector<Split> (*)(std::span<const float>);
    // Pass a permutation of the point rows and weights in original row order.
    EmeansGpu(
        FeatureView points, std::span<const float> weights, std::span<const uint32_t> order, size_t capacity,
        size_t chunk_rows = 65536
    );
    ~EmeansGpu();
    void begin(const decltype(Clustering::centroids)& seeds);
    void batch(size_t first, size_t count, float alpha, bool closing);
    void revive(std::span<float> usage, SplitSelector choose);
    Clustering finish();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::spatial
