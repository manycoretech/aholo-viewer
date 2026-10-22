#pragma once
#include <algorithm>
#include <cstddef>
#include <stdexcept>

namespace splat_transform::spatial {
struct ClusterLimits {
    size_t storage_buffer_bytes;
    size_t workgroups;
    size_t memory_bytes;
};
struct ClusterSchedule {
    size_t batch_rows;
    size_t cached_batches;
    size_t streaming_slots;
};

inline ClusterSchedule cluster_schedule(size_t rows, size_t centroids, size_t stride, ClusterLimits limits) {
    if (!rows || !centroids || !stride) {
        throw std::runtime_error("Invalid GPU clustering dimensions");
    }
    const size_t fixed = centroids * (stride + 1) * sizeof(float);
    if (limits.memory_bytes <= fixed + 128 * (stride + 1) * sizeof(float)) {
        throw std::runtime_error("Insufficient GPU memory budget for clustering centroids and one batch");
    }
    size_t batch_rows = std::min(limits.storage_buffer_bytes / (stride * sizeof(float)), limits.workgroups * 128);
    batch_rows = std::min(rows, std::max<size_t>(128, batch_rows / 128 * 128));
    // Cache a single batch when it fits. Streaming needs up to two reusable slots.
    while (batch_rows > 128 && fixed + batch_rows * (stride + 1) * sizeof(float) * (batch_rows < rows ? 2 : 1) > limits.memory_bytes) {
        batch_rows = std::max<size_t>(128, batch_rows / 2 / 128 * 128);
    }
    const size_t batches = (rows + batch_rows - 1) / batch_rows;
    const size_t slot_bytes = batch_rows * (stride + 1) * sizeof(float);
    const size_t slots = std::max<size_t>(1, (limits.memory_bytes - fixed) / slot_bytes);
    const size_t streams = slots < batches ? std::min<size_t>(2, slots) : 0;
    return { batch_rows, streams ? slots - streams : batches, streams };
}
} // namespace splat_transform::spatial
