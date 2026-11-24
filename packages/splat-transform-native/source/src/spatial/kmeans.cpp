#include "cluster_gpu.h"
#include <spatial/clustering.h>
#include <unordered_set>
#include <utility/logger.h>
#include <utility/random.h>
#include <utility/thread_pool.h>

namespace splat_transform::spatial {
Clustering k_means(FeatureView points, size_t count, size_t iterations) {
    const auto rows = points.rows();
    if (!rows || !count || rows < count) {
        return detail::point_palette(points);
    }
    Clustering result { decltype(Clustering::centroids)(count, points.dimensions()), std::vector<uint32_t>(rows) };
    auto& rng = utility::default_random();
    auto random_index = [&](size_t upper) { return static_cast<size_t>((static_cast<uint64_t>(rng()) * upper) >> 32); };
    auto seed = [&](size_t entry, size_t row) {
        for (size_t column = 0; column < points.dimensions(); ++column) {
            result.centroids(entry, column) = points(row, column);
        }
    };
    std::unordered_set<size_t> selected;
    for (size_t entry = 0; entry < count; ++entry) {
        const size_t last = rows - count + entry;
        const size_t candidate = random_index(last + 1);
        const size_t row = selected.contains(candidate) ? last : candidate;
        selected.insert(row);
        seed(entry, row);
    }
    auto& pool = threading::default_pool();
    struct PartialAverage {
        std::vector<float> sums;
        std::vector<size_t> counts;
    };
    const size_t threads = std::min(rows, pool.thread_count());
    const size_t per_thread = (rows + threads - 1) / threads;
    std::vector<PartialAverage> partials(threads);
    for (auto& partial : partials) {
        partial.sums.resize(count * points.dimensions());
        partial.counts.resize(count);
    }
    auto setup_time = utility::logger().time("kmeans setup");
    ClusterSession session(points, count, (per_thread + 127) / 128 * 128);
    setup_time.finish();
    for (size_t step = 0; step < iterations; ++step) {
        utility::logger().info("kmeans iteration ", step + 1);
        auto assign_time = utility::logger().time("kmeans assign");
        threading::TaskGroup<void> tasks(pool, threads);
        size_t next_thread = 0;
        session.assign(result.centroids, result.labels, [&](size_t ready) {
            while (next_thread < threads) {
                const size_t begin = std::min(rows, next_thread * per_thread), end = std::min(rows, begin + per_thread);
                if (end > ready) {
                    break;
                }
                const size_t thread = next_thread++;
                tasks.submit([&, begin, end, thread] {
                    auto& part = partials[thread];
                    std::ranges::fill(part.sums, 0.0f);
                    std::ranges::fill(part.counts, 0);
                    for (size_t row = begin; row < end; ++row) {
                        const auto label = result.labels[row];
                        ++part.counts[label];
                        for (size_t column = 0; column < points.dimensions(); ++column) {
                            part.sums[static_cast<size_t>(label) * points.dimensions() + column] += points(row, column);
                        }
                    }
                });
            }
        });
        assign_time.finish();
        auto update_time = utility::logger().time("kmeans update tail");
        for (size_t task = 0; task < tasks.size(); ++task) {
            tasks.get(task);
        }
        for (size_t entry = 0; entry < count; ++entry) {
            auto center = result.centroids.row(entry);
            center.setZero();
            size_t population = 0;
            for (const auto& part : partials) {
                population += part.counts[entry];
                for (size_t column = 0; column < points.dimensions(); ++column) {
                    center[column] += part.sums[entry * points.dimensions() + column];
                }
            }
            if (population) {
                center *= 1.0f / static_cast<float>(population);
            } else {
                seed(entry, random_index(rows));
            }
        }
    }
    return result;
}
} // namespace splat_transform::spatial
