#include <algorithm>
#include <cmath>
#include <gpu/compute.h>
#include <numeric>
#include <spatial/clustering.h>
#include <unordered_set>
#include <utility/logger.h>
#include <utility/random.h>
#include <utility/thread_pool.h>

namespace splat_transform::spatial {
Quantization detail::quantize_values(std::vector<float> values, size_t rows, size_t columns) {
    const size_t n = values.size();
    Quantization result;
    result.labels.setZero(rows, columns);
    if (!n) {
        return result;
    }
    auto sorted = values;
    std::ranges::sort(sorted);
    const float min = sorted.front(), max = sorted.back(), range = max - min;
    if (range < 1e-20f) {
        result.centroids.fill(min);
        return result;
    }
    if (!std::isfinite(range)) {
        throw std::runtime_error("Cannot quantize non-finite values");
    }
    const size_t bins = std::min<size_t>(1024, n);
    const float iqr = sorted[n * 3 / 4] - sorted[n / 4];
    const float beta = std::clamp(1 - iqr / range, 0.5f, 0.999f);
    std::vector<size_t> counts(bins, 0);
    std::vector<float> sums(bins, 0), centers(bins), weights(bins);
    for (size_t i = 0; i < n; ++i) {
        const float uniform = (sorted[i] - min) / range;
        const size_t bin = std::min(bins - 1, static_cast<size_t>(std::floor(bins * (beta * (float(i) / n) + (1 - beta) * uniform))));
        ++counts[bin];
        sums[bin] += uniform;
    }
    size_t occupied = 0;
    std::vector<float> prefix(bins + 1, 0), prefix_x(bins + 1, 0), prefix_xx(bins + 1, 0);
    for (size_t i = 0; i < bins; ++i) {
        centers[i] = counts[i] > 0 ? sums[i] / counts[i] : (i + 0.5f) / bins;
        weights[i] = std::sqrt(static_cast<float>(counts[i]));
        occupied += counts[i] > 0;
        prefix[i + 1] = prefix[i] + weights[i];
        prefix_x[i + 1] = prefix_x[i] + weights[i] * centers[i];
        prefix_xx[i + 1] = prefix_xx[i] + weights[i] * centers[i] * centers[i];
    }
    auto cost = [&](size_t a, size_t b) {
        const float w = prefix[b + 1] - prefix[a];
        const float x = prefix_x[b + 1] - prefix_x[a];
        return w <= 0 ? 0.0f : std::max(0.0f, prefix_xx[b + 1] - prefix_xx[a] - x * x / w);
    };
    auto mean = [&](size_t a, size_t b) {
        const float w = prefix[b + 1] - prefix[a];
        return w <= 0 ? std::midpoint(centers[a], centers[b]) : std::clamp((prefix_x[b + 1] - prefix_x[a]) / w, 0.0f, 1.0f);
    };
    const size_t k = std::min<size_t>(256, occupied);
    std::vector<float> previous(bins, 1e30f), current(bins, 1e30f);
    std::vector<std::vector<int>> splits(k + 1, std::vector<int>(bins, -1));
    for (size_t j = 0; j < bins; ++j) {
        previous[j] = cost(0, j);
    }
    for (size_t m = 2; m <= k; ++m) {
        std::fill(current.begin(), current.end(), 1e30f);
        for (size_t j = m - 1; j < bins; ++j) {
            float best = 1e30f;
            int split = static_cast<int>(m) - 2;
            for (size_t s = m - 2; s < j; ++s) {
                const float value = previous[s] + cost(s + 1, j);
                if (value < best) {
                    best = value;
                    split = static_cast<int>(s);
                }
            }
            current[j] = best;
            splits[m][j] = split;
        }
        previous.swap(current);
    }
    int j = static_cast<int>(bins) - 1;
    for (size_t m = k; m > 0; --m) {
        const int s = m > 1 ? splits[m][j] : -1;
        result.centroids[m - 1] = std::lerp(min, max, mean(s + 1, j));
        j = s;
    }
    std::ranges::sort(std::span(result.centroids).first(k));
    std::ranges::fill(std::span(result.centroids).subspan(k), result.centroids[k - 1]);
    std::array<float, 255> boundaries;
    for (size_t i = 0; i < boundaries.size(); ++i) {
        boundaries[i] = std::midpoint(result.centroids[i], result.centroids[i + 1]);
    }
    for (size_t i = 0; i < n; ++i) {
        // Equal boundaries select the higher bin, including repeated centroids.
        const auto bin = std::ranges::upper_bound(boundaries, values[i]);
        result.labels(i % rows, i / rows) = static_cast<uint8_t>(bin - boundaries.begin());
    }
    return result;
}
Clustering k_means(FeatureView points, size_t count, size_t iterations) {
    const auto rows = points.rows();
    if (!rows || !count || rows < count) {
        FeatureMatrix centroids(rows, points.dimensions());
        for (size_t row = 0; row < rows; ++row) {
            for (size_t c = 0; c < points.dimensions(); ++c) {
                centroids(row, c) = points(row, c);
            }
        }
        std::vector<uint32_t> labels(rows);
        std::iota(labels.begin(), labels.end(), 0);
        return { std::move(centroids), std::move(labels) };
    }
    Clustering result { FeatureMatrix::Zero(count, points.dimensions()), {} };
    auto& rng = utility::default_random();
    auto random_index = [&](size_t upper) { return static_cast<size_t>((uint64_t(rng()) * upper) >> 32); };
    std::unordered_set<size_t> selected;
    size_t centroid = 0;
    for (size_t j = rows - count; j < rows; ++j) {
        size_t row = random_index(j + 1);
        if (selected.contains(row)) {
            row = j;
        }
        selected.insert(row);
        for (size_t c = 0; c < points.dimensions(); ++c) {
            result.centroids(centroid, c) = points(row, c);
        }
        ++centroid;
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
    gpu::ClusterSession session(points, count);
    for (size_t step = 0; step < iterations; ++step) {
        utility::logger().info("kmeans iteration ", step + 1);
        result.labels = session.assign(result.centroids);
        threading::TaskGroup<void> tasks(pool, threads);
        for (size_t thread = 0; thread < threads; ++thread) {
            const size_t begin = std::min(rows, thread * per_thread), end = std::min(rows, begin + per_thread);
            tasks.submit([&, begin, end, thread] {
                auto& part = partials[thread];
                std::fill(part.sums.begin(), part.sums.end(), 0.0f);
                std::fill(part.counts.begin(), part.counts.end(), 0);
                for (size_t row = begin; row < end; ++row) {
                    const auto label = result.labels[row];
                    ++part.counts[label];
                    for (size_t c = 0; c < points.dimensions(); ++c) {
                        part.sums[size_t(label) * points.dimensions() + c] += points(row, c);
                    }
                }
            });
        }
        for (size_t i = 0; i < tasks.size(); ++i) {
            tasks.get(i);
        }
        for (size_t k = 0; k < count; ++k) {
            size_t n = 0;
            for (size_t c = 0; c < points.dimensions(); ++c) {
                result.centroids(k, c) = 0;
            }
            for (const auto& part : partials) {
                n += part.counts[k];
                for (size_t c = 0; c < points.dimensions(); ++c) {
                    result.centroids(k, c) += part.sums[k * points.dimensions() + c];
                }
            }
            if (n) {
                const float inverse = 1.0f / static_cast<float>(n);
                for (size_t c = 0; c < points.dimensions(); ++c) {
                    result.centroids(k, c) *= inverse;
                }
            } else {
                const size_t row = random_index(rows);
                for (size_t c = 0; c < points.dimensions(); ++c) {
                    result.centroids(k, c) = points(row, c);
                }
            }
        }
    }
    return result;
}
} // namespace splat_transform::spatial
