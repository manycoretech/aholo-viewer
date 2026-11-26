#include "emeans_gpu.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <gpu/compute.h>
#include <limits>
#include <numbers>
#include <numeric>
#include <spatial/clustering.h>
#include <utility/logger.h>
#include <utility/random.h>

namespace splat_transform::spatial {
std::vector<float> sh_palette_weights(const splat::Splat& data) {
    std::vector<float> weights(data.size());
    double total = 0;
    for (size_t row = 0; row < data.size(); ++row) {
        const auto& point = data.gaussians[row];
        const auto& axes = point.scale;
        const double largest = std::max(axes[0], axes[1]);
        const double other = std::max(std::min(axes[0], axes[1]), axes[2]);
        const double area = std::max(0.0, largest) * std::max(0.0, other);
        const float weight = static_cast<float>(std::clamp(point.opacity, 0.0f, 1.0f) * std::sqrt(std::sqrt(area)));
        weights[row] = std::isfinite(weight) ? weight : 0.0f;
        total += weights[row];
    }
    if (total > 0) {
        const double normalize = weights.size() / total;
        for (auto& weight : weights) {
            weight = static_cast<float>(weight * normalize);
        }
    } else {
        std::ranges::fill(weights, 1.0f);
    }
    return weights;
}

namespace {
using Centers = decltype(Clustering::centroids);
constexpr size_t PaletteRow = 64;

double random_unit() {
    auto& engine = utility::default_random();
    return (static_cast<double>(engine()) + 0.5) / (static_cast<double>(engine.max()) + 1.0);
}

void copy_point(FeatureView points, size_t row, Centers& centers, size_t entry) {
    for (size_t column = 0; column < points.dimensions(); ++column) {
        centers(entry, column) = points(row, column);
    }
}

double squared_error(FeatureView points, size_t row, const float* center) {
    double error = 0;
    for (size_t column = 0; column < points.dimensions(); ++column) {
        const double delta = static_cast<double>(points(row, column)) - center[column];
        error += delta * delta;
    }
    return error;
}

double color_error(FeatureView points, const Clustering& palette, std::span<const float> weights) {
    double weighted_error = 0;
    double total = 0;
    for (size_t row = 0; row < points.rows(); ++row) {
        weighted_error += weights[row] * squared_error(points, row, palette.centroids.row(palette.labels[row]).data());
        total += weights[row];
    }
    return 255 * std::sqrt(weighted_error / (total * 12 * std::numbers::pi));
}

size_t batch_size(size_t points, size_t count, size_t dimensions, size_t epochs) {
    const bool quality = dimensions <= 16;
    const double estimate = (quality ? 0.00439175 : 0.035134) * std::pow(count, 0.134749) * std::pow(points, 0.876473) * std::pow(epochs, 0.813344);
    auto round_power = [](double value) { return static_cast<size_t>(std::exp2(std::round(std::log2(std::max(1.0, value))))); };
    return std::min(round_power(estimate), quality ? points / 2 : round_power(points / 2.0));
}

std::vector<EmeansGpu::Split> choose_splits(std::span<const float> usage) {
    const double threshold = 0.1 * std::accumulate(usage.begin(), usage.end(), 0.0) / usage.size();
    std::vector<size_t> targets;
    std::vector<std::pair<double, size_t>> donors;
    for (size_t entry = 0; entry < usage.size(); ++entry) {
        if (usage[entry] < threshold) {
            targets.push_back(entry);
        } else if (usage[entry] > 0) {
            donors.emplace_back(std::log(usage[entry]) - std::log(-std::log(random_unit())), entry);
        }
    }
    const size_t pairs = std::min(targets.size(), donors.size());
    std::partial_sort(donors.begin(), donors.begin() + pairs, donors.end(), std::greater {});
    std::vector<EmeansGpu::Split> splits(pairs);
    for (size_t pair = 0; pair < pairs; ++pair) {
        splits[pair] = { static_cast<uint32_t>(donors[pair].second), static_cast<uint32_t>(targets[pair]) };
    }
    return splits;
}

struct Probe {
    size_t count;
    double error;
};

struct Trainer {
    FeatureView points;
    std::span<const float> weights;
    std::span<const uint32_t> order;
    EmeansGpu& session;

    Centers seed(size_t count) const {
        Centers centers(count, this->points.dimensions());
        const size_t start = std::uniform_int_distribution<size_t>(0, this->order.size() - 1)(utility::default_random());
        for (size_t entry = 0; entry < count; ++entry) {
            copy_point(this->points, this->order[(start + entry) % this->order.size()], centers, entry);
        }
        return centers;
    }

    Clustering train(const Centers& centers, size_t epochs) const {
        const size_t count = static_cast<size_t>(centers.rows()), rows = this->points.rows();
        const size_t batch = batch_size(rows, count, this->points.dimensions(), epochs);
        const size_t steps = epochs * ((rows + batch - 1) / batch);
        const double initial = std::clamp(0.8244 * std::pow(count, -0.4617) * std::pow(batch, 0.9003) * std::pow(rows, -0.4498) * std::pow(epochs, -0.1057), 1e-4, 1.0);
        this->session.begin(centers);
        std::vector<float> usage(count);
        size_t step = 0;
        for (size_t epoch = 0; epoch < epochs; ++epoch) {
            const bool closing = epoch + 1 == epochs;
            const size_t start = std::uniform_int_distribution<size_t>(0, rows - 1)(utility::default_random());
            for (size_t begin = 0; begin < rows; begin += batch) {
                const size_t length = std::min(batch, rows - begin);
                const size_t first = (start + begin) % rows;
                const float alpha = static_cast<float>(initial * (0.55 + 0.45 * std::cos(std::numbers::pi * step / steps)));
                this->session.batch(first, length, alpha, closing);
                if (++step % 5 == 0) {
                    this->session.revive(usage, choose_splits);
                }
            }
        }
        return this->session.finish();
    }

    Centers grow(Clustering&& previous, size_t next) const {
        auto centers = std::move(previous.centroids);
        const size_t count = static_cast<size_t>(centers.rows());
        std::vector<double> errors(count), keys(count, -std::numeric_limits<double>::infinity());
        std::vector<size_t> samples(count), entries(count);
        for (size_t row = 0; row < this->points.rows(); ++row) {
            const auto entry = previous.labels[row];
            const auto weight = this->weights[row];
            if (weight <= 0) {
                continue;
            }
            errors[entry] += weight * squared_error(this->points, row, centers.row(entry).data());
            const double key = std::log(random_unit()) / weight;
            if (key > keys[entry]) {
                samples[entry] = row;
                keys[entry] = key;
            }
        }
        std::iota(entries.begin(), entries.end(), 0);
        std::ranges::sort(entries, std::greater {}, [&](size_t entry) { return errors[entry]; });
        centers.conservativeResize(next, Eigen::NoChange);
        std::uniform_int_distribution<size_t> random_row(0, this->points.rows() - 1);
        for (size_t entry = count; entry < next; ++entry) {
            const size_t rank = entry - count;
            const size_t row = rank < count && errors[entries[rank]] > 0 ? samples[entries[rank]] : random_row(utility::default_random());
            copy_point(this->points, row, centers, entry);
        }
        return centers;
    }
};

double error_slope(Probe first, Probe second) {
    return std::log(second.error / first.error) / std::log(static_cast<double>(second.count) / first.count);
}
Clustering search_palette(const splat::Splat& data, size_t max_count, bool exact_allowed, double target) {
    const FeatureView points(data);
    const size_t rows = points.rows();
    auto weights = sh_palette_weights(data);
    std::vector<uint32_t> order(rows);
    std::iota(order.begin(), order.end(), 0);
    std::shuffle(order.begin(), order.end(), utility::default_random());
    EmeansGpu session(points, weights, order, max_count);
    Trainer trainer { points, weights, order, session };
    auto align = [&](double count) {
        return static_cast<size_t>(std::clamp(std::ceil(count / PaletteRow) * PaletteRow, static_cast<double>(PaletteRow), static_cast<double>(max_count)));
    };
    auto measure = [&](const Clustering& palette) {
        Probe probe { static_cast<size_t>(palette.centroids.rows()), color_error(points, palette, weights) };
        utility::logger().info("SOG SH e-means entries=", probe.count, " colorError=", probe.error, " target=", target);
        return probe;
    };
    auto palette = trainer.train(trainer.seed(std::min<size_t>(4096, max_count)), 3);
    auto best = measure(palette);
    if (best.error > target) {
        double slope = -0.15;
        while (best.error > target && best.count < max_count) {
            const double factor = slope < 0 && std::isfinite(slope) ? std::pow(target / best.error, 1 / slope) : 2;
            const size_t next = align(best.count * std::clamp(factor, 1.1, 2.0));
            palette = trainer.train(trainer.grow(std::move(palette), next), 2);
            const auto probe = measure(palette);
            slope = error_slope(best, probe);
            best = probe;
        }
        return best.error > target && exact_allowed ? detail::point_palette(points) : std::move(palette);
    }
    Probe failing {}, previous {};
    for (size_t tried = 1; tried < 6 && best.count > PaletteRow && best.error < target * 0.98; ++tried) {
        if (failing.count && best.count <= 1.25 * failing.count) {
            break;
        }
        const auto other = failing.count ? failing : previous;
        const double slope = other.count ? error_slope(best, other) : 0;
        const bool fitted = slope < 0 && std::isfinite(slope) && best.error > 0;
        const double ratio = fitted ? std::pow(target / best.error, 1 / slope) : 0;
        double next = best.count / 4.0;
        if (failing.count) {
            const double guess = fitted ? best.count * ratio : std::sqrt(static_cast<double>(best.count) * failing.count);
            next = std::min(best.count / 1.05, std::max(failing.count * 1.05, guess));
        } else if (fitted) {
            next = best.count * std::clamp(std::pow(ratio, 0.7), 1 / 16.0, 1 / 1.2);
        }
        const size_t count = align(next);
        if (count >= best.count || count <= failing.count) {
            break;
        }
        auto candidate = trainer.train(trainer.seed(count), 3);
        const auto probe = measure(candidate);
        if (probe.error <= target) {
            previous = best;
            best = probe;
            palette = std::move(candidate);
        } else {
            failing = probe;
        }
    }
    return palette;
}
} // namespace

Clustering cluster_sh_to_color_error(const splat::Splat& data, size_t limit, double target) {
    const FeatureView points(data);
    const size_t rows = points.rows();
    const bool exact_allowed = rows <= limit;
    const size_t max_count = exact_allowed && rows ? (rows - 1) / PaletteRow * PaletteRow : limit;
    if (!rows || max_count < PaletteRow) {
        return detail::point_palette(points);
    }
    constexpr size_t ResidentBytes = size_t { 2 } * 1024 * 1024 * 1024;
    if (rows <= ResidentBytes / sizeof(float) / points.dimensions() && rows <= gpu::ComputeDevice().limits().storage_buffer_bytes / sizeof(uint32_t)) {
        try {
            return search_palette(data, max_count, exact_allowed, target);
        } catch (const gpu::AllocationFailure& error) {
            utility::logger().warn("SOG SH e-means workspace: ", error.what());
        }
    }
    const size_t fixed = std::min({ std::bit_floor(rows), limit, size_t { 65536 } });
    utility::logger().info("SOG SH exceeds the e-means search budget, using ", fixed, " Lloyd entries");
    return k_means(points, fixed);
}
} // namespace splat_transform::spatial
