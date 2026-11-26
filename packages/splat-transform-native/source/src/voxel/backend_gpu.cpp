#include "voxelize.h"
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <utility/logger.h>
#include <utility/parallel.h>

namespace splat_transform::voxel {
namespace {
constexpr int32_t BATCH_BLOCKS = Grid::Storage::block_side;
struct Batch {
    Eigen::Vector3i origin;
    Eigen::Vector3i dimensions;
    uint32_t offset;
    uint32_t count;
};
struct Batches {
    std::vector<Batch> batches;
    std::vector<uint32_t> indices;
};
void sort_candidates(CandidateBins& candidates) {
    const auto sort = [&](size_t begin, size_t end) {
        for (size_t key = begin; key < end; ++key) {
            const auto count = candidates.counts[key];
            if (count > 1) {
                const auto first = candidates.indices.begin() + candidates.offsets[key];
                std::sort(first, first + count);
            }
        }
    };
    const size_t bins = candidates.counts.size();
    const size_t grain = bins < 4096 ? 1 : 32;
    if (bins <= grain || candidates.indices.size() < 4096) {
        sort(0, bins);
        return;
    }
    threading::parallel_chunks(bins, grain, sort);
}
Batches build_batches(VoxelSession& session, const PreparedData& data, const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution) {
    Eigen::Vector3i count;
    for (int32_t a = 0; a < 3; ++a) {
        count[a] = (grid.blocks[a] + BATCH_BLOCKS - 1) / BATCH_BLOCKS;
    }
    const float batch_size = Grid::Storage::voxel_side * resolution;
    auto candidates_time = utility::logger().time("Voxel GPU candidates");
    auto candidates = session.candidates(data.gaussians,
        { static_cast<float>(bounds.min()[0]), static_cast<float>(bounds.min()[1]), static_cast<float>(bounds.min()[2]) }, static_cast<float>(batch_size),
        { static_cast<uint32_t>(count[0]), static_cast<uint32_t>(count[1]), static_cast<uint32_t>(count[2]) });
    candidates_time.finish();
    auto sort_time = utility::logger().time("Voxel GPU candidate sorting");
    // Each bin owns a disjoint range. Parallel sorting preserves the exact
    // ascending accumulation order without serializing all scene candidates.
    sort_candidates(candidates);
    std::vector<Batch> output;
    output.reserve(std::ranges::count_if(candidates.counts, [](auto size) { return size != 0; }));
    for (size_t key = 0; key < candidates.counts.size(); ++key) {
        if (!candidates.counts[key]) {
            continue;
        }
        Eigen::Vector3i origin { static_cast<int32_t>(key % count[0]) * BATCH_BLOCKS,
            static_cast<int32_t>(key / count[0] % count[1]) * BATCH_BLOCKS,
            static_cast<int32_t>(key / (static_cast<uint64_t>(count[0]) * count[1])) * BATCH_BLOCKS };
        Eigen::Vector3i dimensions;
        for (int32_t a = 0; a < 3; ++a) {
            dimensions[a] = std::min(BATCH_BLOCKS, grid.blocks[a] - origin[a]);
        }
        output.push_back({ origin, dimensions, candidates.offsets[key], candidates.counts[key] });
    }
    return { std::move(output), std::move(candidates.indices) };
}

class GpuBackend final : public Backend {
public:
    std::string_view name() const noexcept override { return "GPU"; }
    bool requires_gpu() const noexcept override { return true; }
    Grid voxelize(const PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff) const override {
        auto output = make_grid(bounds, resolution);
        const auto [batches, indices] = build_batches(this->session_, data, output, bounds, resolution);
        std::vector<VoxelBatch> specs;
        specs.reserve(batches.size());
        for (const auto& b : batches) {
            specs.push_back({ b.offset, b.count, static_cast<uint32_t>(b.dimensions[0]), static_cast<uint32_t>(b.dimensions[1]), static_cast<uint32_t>(b.dimensions[2]),
                static_cast<float>(bounds.min()[0] + b.origin[0] * 4 * resolution),
                static_cast<float>(bounds.min()[1] + b.origin[1] * 4 * resolution),
                static_cast<float>(bounds.min()[2] + b.origin[2] * 4 * resolution) });
        }
        // The voxel session splits for device storage/dispatch limits and retains the
        // full Gaussian input across splits. Fixed 256-batch calls re-uploaded the
        // entire scene on every call, even though only the batch descriptors changed.
        auto dispatch_time = utility::logger().time("Voxel GPU dispatch");
        const auto masks = this->session_.voxelize(data.gaussians, indices, specs, resolution, cutoff, Grid::Storage::block_capacity);
        dispatch_time.finish();
        output.masks.assign_bricks(batches.size(),
            [&](size_t i) { return output.masks.brick_index(batches[i].origin); },
            [&](size_t i) {
                Grid::Storage::Masks brick {};
                const auto& dims = batches[i].dimensions;
                const uint32_t* words = masks.data() + i * Grid::Storage::block_capacity * 2;
                if constexpr (std::endian::native == std::endian::little) {
                    if ((dims.array() == BATCH_BLOCKS).all()) {
                        std::memcpy(brick.data(), words, sizeof(brick));
                        return brick;
                    }
                }
                for (int32_t z = 0; z < dims.z(); ++z) {
                    for (int32_t y = 0; y < dims.y(); ++y) {
                        for (int32_t x = 0; x < dims.x(); ++x) {
                            brick[x + BATCH_BLOCKS * (y + BATCH_BLOCKS * z)] = static_cast<uint64_t>(words[0]) | (static_cast<uint64_t>(words[1]) << 32);
                            words += 2;
                        }
                    }
                }
                return brick;
            });
        return output;
    }
    Grid dilate(const Grid& grid, Eigen::Vector3i radius) const override {
        std::vector<uint32_t> packed;
        const auto active = grid.active_blocks();
        packed.reserve(active.size() * 3);
        for (auto index : active) {
            const auto bits = grid.mask(index);
            packed.insert(packed.end(), { index, static_cast<uint32_t>(bits), static_cast<uint32_t>(bits >> 32) });
        }
        const auto masks = this->session_.dilate_blocks(packed, { static_cast<uint32_t>(grid.size[0]), static_cast<uint32_t>(grid.size[1]), static_cast<uint32_t>(grid.size[2]) },
            { static_cast<uint32_t>(radius[0]), static_cast<uint32_t>(radius[1]), static_cast<uint32_t>(radius[2]) });
        Grid output(grid.size);
        for (uint32_t index = 0; index < grid.block_count(); ++index) {
            output.set_mask(index, static_cast<uint64_t>(masks[index * 2]) | (static_cast<uint64_t>(masks[index * 2 + 1]) << 32));
        }
        return output;
    }

private:
    mutable VoxelSession session_;
};
} // namespace

std::unique_ptr<Backend> gpu_backend() {
    return std::make_unique<GpuBackend>();
}
} // namespace splat_transform::voxel
