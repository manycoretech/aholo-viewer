#pragma once
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <limits>
#include <utility/thread_pool.h>

namespace splat_transform::threading {
// Bound the queue to one job per worker. TaskGroup also supports calls made by
// a worker of the same pool and joins every reader before unwinding.
template<typename F>
void parallel_chunks(size_t count, size_t grain, F&& function) {
    if (count <= grain) {
        if (count) {
            function(size_t { 0 }, count);
        }
        return;
    }
    auto& pool = default_pool();
    const auto workers = std::min(pool.thread_count(), (count - 1) / grain + 1);
    std::atomic<size_t> next { 0 };
    TaskGroup<void> tasks(pool, workers);
    for (size_t worker = 0; worker < workers; ++worker) {
        tasks.submit([&] {
            for (auto begin = next.fetch_add(grain, std::memory_order_relaxed); begin < count;
                begin = next.fetch_add(grain, std::memory_order_relaxed)) {
                function(begin, std::min(count, begin + grain));
            }
        });
    }
    for (size_t worker = 0; worker < tasks.size(); ++worker) {
        tasks.get(worker);
    }
}

// Each predicate runs once. Prefix offsets allow the workers to compact into
// disjoint output ranges, preserving input order regardless of scheduling.
template<typename Predicate>
std::vector<uint32_t> select_indices(size_t count, Predicate&& keep) {
    constexpr size_t grain = 1024;
    std::vector<uint8_t> mask(count);
    std::vector<size_t> offsets((count + grain - 1) / grain + 1);
    parallel_chunks(count, grain, [&](size_t begin, size_t end) {
        size_t kept = 0;
        for (size_t i = begin; i < end; ++i) {
            mask[i] = keep(i);
            kept += mask[i];
        }
        offsets[begin / grain + 1] = kept;
    });
    for (size_t i = 1; i < offsets.size(); ++i) {
        offsets[i] += offsets[i - 1];
    }
    std::vector<uint32_t> selected(offsets.back());
    parallel_chunks(count, grain, [&](size_t begin, size_t end) {
        auto out = offsets[begin / grain];
        for (size_t i = begin; i < end; ++i) {
            if (mask[i]) {
                selected[out++] = static_cast<uint32_t>(i);
            }
        }
    });
    return selected;
}
} // namespace splat_transform::threading
