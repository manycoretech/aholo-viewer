#include "voxelize.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <utility/thread_pool.h>

namespace splat_transform::voxel {
namespace {
constexpr int BATCH_VOXELS = 16;
constexpr int BATCH_BLOCKS = BATCH_VOXELS / 4;

// Keep only one job per available worker in the shared queue. Dynamic chunks
// balance sparse/dense regions; TaskGroup joins borrowed state on exceptions and
// cooperatively waits when voxelization itself runs inside the default pool.
template<typename F>
void parallel_chunks(size_t count, size_t grain, F&& function) {
    if (!count) {
        return;
    }
    if (count <= grain) {
        function(size_t(0), count);
        return;
    }
    auto& pool = threading::default_pool();
    const size_t workers = std::min(pool.thread_count(), (count - 1) / grain + 1);
    std::atomic<size_t> next { 0 };
    threading::TaskGroup<void> tasks(pool, workers);
    for (size_t worker = 0; worker < workers; ++worker) {
        tasks.submit([&] {
            for (;;) {
                const auto begin = next.fetch_add(grain, std::memory_order_relaxed);
                if (begin >= count) {
                    return;
                }
                function(begin, std::min(count, begin + grain));
            }
        });
    }
    for (size_t worker = 0; worker < tasks.size(); ++worker) {
        tasks.get(worker);
    }
}

// Match the historical CPU worker's floor/ceil voxel window, including a
// Gaussian whose center lies outside the grid but whose extent overlaps it.
bool voxel_range(const gpu::Gaussian& gaussian, const Grid& grid, const Eigen::AlignedBox3f& bounds,
    float resolution, Point& minimum, Point& maximum) {
    const auto& g = gaussian.values;
    if (!(g[3] > ALPHA_THRESHOLD) || !std::all_of(g.begin(), g.begin() + 14, [](float value) { return std::isfinite(value); })) {
        return false;
    }
    for (int a = 0; a < 3; ++a) {
        const float low = std::floor((g[a] - g[11 + a] - bounds.min()[a]) / resolution);
        const float high = std::ceil((g[a] + g[11 + a] - bounds.min()[a]) / resolution);
        if (g[11 + a] < 0 || low > grid.size[a] - 1 || high < 0) {
            return false;
        }
        // Clamp in floating point before converting extreme coordinates.
        minimum[a] = int(std::max(0.0f, low));
        maximum[a] = int(std::min(float(grid.size[a] - 1), high));
        if (minimum[a] > maximum[a]) {
            return false;
        }
    }
    return true;
}

class CpuBackend final : public Backend {
public:
    std::string_view name() const noexcept override { return "CPU"; }
    bool requires_gpu() const noexcept override { return false; }
    Grid voxelize(const PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff) const override {
        auto grid = make_grid(bounds, resolution);
        if (data.gaussians.size() > std::numeric_limits<uint32_t>::max()) {
            throw std::runtime_error("CPU voxel Gaussian indices exceed 32 bits");
        }
        Point dimensions;
        for (int a = 0; a < 3; ++a) {
            dimensions[a] = (grid.blocks[a] + BATCH_BLOCKS - 1) / BATCH_BLOCKS;
        }
        const size_t batch_count = size_t(dimensions[0]) * dimensions[1] * dimensions[2];
        std::vector<uint32_t> counts(batch_count);
        auto visit_batches = [&](size_t index, auto&& visit) {
            Point minimum, maximum;
            if (!voxel_range(data.gaussians[index], grid, bounds, resolution, minimum, maximum)) {
                return;
            }
            for (int z = minimum[2] / BATCH_VOXELS; z <= maximum[2] / BATCH_VOXELS; ++z) {
                for (int y = minimum[1] / BATCH_VOXELS; y <= maximum[1] / BATCH_VOXELS; ++y) {
                    for (int x = minimum[0] / BATCH_VOXELS; x <= maximum[0] / BATCH_VOXELS; ++x) {
                        visit(x + size_t(y) * dimensions[0] + size_t(z) * dimensions[0] * dimensions[1]);
                    }
                }
            }
        };
        parallel_chunks(data.gaussians.size(), 4096, [&](size_t begin, size_t end) {
            for (size_t i = begin; i < end; ++i) {
                visit_batches(i, [&](size_t key) { std::atomic_ref(counts[key]).fetch_add(1, std::memory_order_relaxed); });
            }
        });
        std::vector<size_t> offsets(batch_count + 1);
        std::vector<uint32_t> active;
        for (size_t i = 0; i < batch_count; ++i) {
            if (counts[i]) {
                active.push_back(uint32_t(i));
            }
            if (counts[i] > std::vector<uint32_t>().max_size() - offsets[i]) {
                throw std::runtime_error("CPU voxel candidate buffer exceeds addressable memory");
            }
            offsets[i + 1] = offsets[i] + counts[i];
        }
        // One packed index array, shared with all evaluation jobs. No per-worker
        // geometry copies, per-bin vectors, or copies of the source's SH data.
        std::vector<uint32_t> indices(offsets.back());
        std::fill(counts.begin(), counts.end(), 0);
        parallel_chunks(data.gaussians.size(), 4096, [&](size_t begin, size_t end) {
            for (size_t i = begin; i < end; ++i) {
                visit_batches(i, [&](size_t key) {
                    const auto position = std::atomic_ref(counts[key]).fetch_add(1, std::memory_order_relaxed);
                    indices[offsets[key] + position] = uint32_t(i);
                });
            }
        });
        std::vector<uint32_t>().swap(counts);
        std::vector<std::array<uint64_t, 64>> masks(active.size());
        const float half = resolution * 0.5f;
        const float sigma_cutoff = float(-std::log1p(-std::min(double(cutoff), 1.0 - 1e-8)));
        parallel_chunks(active.size(), 1, [&](size_t begin, size_t end) {
            for (size_t batch = begin; batch < end; ++batch) {
                const auto key = active[batch];
                const Point origin { int(key % dimensions[0]) * BATCH_VOXELS,
                    int(key / dimensions[0] % dimensions[1]) * BATCH_VOXELS,
                    int(key / (size_t(dimensions[0]) * dimensions[1])) * BATCH_VOXELS };
                std::array<float, BATCH_VOXELS * BATCH_VOXELS * BATCH_VOXELS> density {};
                auto& result = masks[batch];
                // Atomic scatter order varies; accumulation must not.
                std::sort(indices.begin() + offsets[key], indices.begin() + offsets[key + 1]);
                for (size_t candidate = offsets[key]; candidate < offsets[key + 1]; ++candidate) {
                    const auto& gaussian = data.gaussians[indices[candidate]];
                    const auto& g = gaussian.values;
                    Point minimum, maximum;
                    if (!voxel_range(gaussian, grid, bounds, resolution, minimum, maximum)) {
                        continue;
                    }
                    for (int a = 0; a < 3; ++a) {
                        minimum[a] = std::max(minimum[a], origin[a]);
                        maximum[a] = std::min(maximum[a], origin[a] + BATCH_VOXELS - 1);
                    }
                    const float max_distance = -2 * std::log(ALPHA_THRESHOLD / g[3]);
                    const Eigen::Quaternionf inverse_rotation(g[4], -g[5], -g[6], -g[7]);
                    const Eigen::Vector3f inverse_scale = Eigen::Map<const Eigen::Vector3f>(g.data() + 8).cwiseMax(1e-8f).cwiseInverse();
                    for (int z = minimum[2]; z <= maximum[2]; ++z) {
                        for (int y = minimum[1]; y <= maximum[1]; ++y) {
                            for (int x = minimum[0]; x <= maximum[0]; ++x) {
                                const Point local { x - origin[0], y - origin[1], z - origin[2] };
                                const int block = local[0] / 4 + local[1] / 4 * 4 + local[2] / 4 * 16;
                                const uint64_t bit = uint64_t { 1 } << ((x & 3) + (y & 3) * 4 + (z & 3) * 16);
                                if (result[block] & bit) {
                                    continue;
                                }
                                const Eigen::Vector3f center = bounds.min() + (Eigen::Vector3f(float(x), float(y), float(z)).array() + 0.5f).matrix() * resolution;
                                const Eigen::Map<const Eigen::Vector3f> mean(g.data());
                                const Eigen::Vector3f difference = mean.cwiseMax((center.array() - half).matrix()).cwiseMin((center.array() + half).matrix()) - mean;
                                const float distance = (inverse_rotation * difference).cwiseProduct(inverse_scale).squaredNorm();
                                if (distance > max_distance) {
                                    continue;
                                }
                                auto& total = density[local[0] + local[1] * BATCH_VOXELS + local[2] * BATCH_VOXELS * BATCH_VOXELS];
                                total += g[3] * std::exp(-0.5f * distance);
                                if (total >= sigma_cutoff) {
                                    result[block] |= bit;
                                }
                            }
                        }
                    }
                }
            }
        });
        // Grid's sparse map is merged on the caller after all independent masks are
        // complete. Workers never mutate the shared unordered_map.
        for (size_t batch = 0; batch < active.size(); ++batch) {
            const auto key = active[batch];
            const Point origin { int(key % dimensions[0]) * BATCH_BLOCKS,
                int(key / dimensions[0] % dimensions[1]) * BATCH_BLOCKS,
                int(key / (size_t(dimensions[0]) * dimensions[1])) * BATCH_BLOCKS };
            for (int block = 0; block < 64; ++block) {
                if (masks[batch][block]) {
                    grid.set_mask(grid.block_index({ origin[0] + block % 4, origin[1] + block / 4 % 4, origin[2] + block / 16 }), masks[batch][block]);
                }
            }
        }
        return grid;
    }
    Grid dilate(const Grid& grid, Point radius) const override {
        Grid output = grid;
        for (int axis = 0; axis < 3; ++axis) {
            for (int distance = 0; distance < radius[axis]; ++distance) {
                Grid next = output;
                for (auto index : output.active_blocks()) {
                    auto p = output.block_point(index);
                    const uint64_t bits = output.mask(index);
                    next.or_mask(index, ((bits & ~face_mask(axis, 3)) << BIT_STRIDES[axis]) | ((bits & ~face_mask(axis, 0)) >> BIT_STRIDES[axis]));
                    if (p[axis] > 0) {
                        --p[axis];
                        next.or_mask(next.block_index(p), (bits & face_mask(axis, 0)) << (3 * BIT_STRIDES[axis]));
                        ++p[axis];
                    }
                    if (p[axis] + 1 < output.blocks[axis]) {
                        ++p[axis];
                        next.or_mask(next.block_index(p), (bits & face_mask(axis, 3)) >> (3 * BIT_STRIDES[axis]));
                    }
                }
                output = std::move(next);
            }
        }
        return output;
    }
};
} // namespace

const Backend& cpu_backend() {
    static const CpuBackend backend;
    return backend;
}
} // namespace splat_transform::voxel
