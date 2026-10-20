#include "voxelize.h"
#include <algorithm>

namespace splat_transform::voxel {
namespace {
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
Batches build_batches(const PreparedData& data, const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution) {
    Eigen::Vector3i count;
    for (int a = 0; a < 3; ++a) {
        count[a] = (grid.blocks[a] + 3) / 4;
    }
    const float batch_size = 16 * resolution;
    auto candidates = gpu::candidates(data.gaussians, { float(bounds.min()[0]), float(bounds.min()[1]), float(bounds.min()[2]) }, float(batch_size),
        { uint32_t(count[0]), uint32_t(count[1]), uint32_t(count[2]) });
    std::vector<Batch> output;
    output.reserve(std::ranges::count_if(candidates.counts, [](auto size) { return size != 0; }));
    for (size_t key = 0; key < candidates.counts.size(); ++key) {
        if (!candidates.counts[key]) {
            continue;
        }
        const auto start = candidates.indices.begin() + candidates.offsets[key];
        // Keep deterministic accumulation order without copying each bin and
        // subsequently flattening all of those copies into another buffer.
        std::sort(start, start + candidates.counts[key]);
        Eigen::Vector3i origin { int(key % count[0]) * 4, int(key / count[0] % count[1]) * 4, int(key / (uint64_t(count[0]) * count[1])) * 4 };
        Eigen::Vector3i dimensions;
        for (int a = 0; a < 3; ++a) {
            dimensions[a] = std::min(4, grid.blocks[a] - origin[a]);
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
        const auto [batches, indices] = build_batches(data, output, bounds, resolution);
        std::vector<gpu::VoxelBatch> specs;
        specs.reserve(batches.size());
        for (const auto& b : batches) {
            specs.push_back({ b.offset, b.count, uint32_t(b.dimensions[0]), uint32_t(b.dimensions[1]), uint32_t(b.dimensions[2]),
                float(bounds.min()[0] + b.origin[0] * 4 * resolution), float(bounds.min()[1] + b.origin[1] * 4 * resolution), float(bounds.min()[2] + b.origin[2] * 4 * resolution) });
        }
        // The GPU layer splits for device storage/dispatch limits and retains the
        // full Gaussian input across splits. Fixed 256-batch calls re-uploaded the
        // entire scene on every call, even though only the batch descriptors changed.
        const auto masks = gpu::voxelize(data.gaussians, indices, specs, resolution, cutoff, 64);
        for (size_t j = 0; j < batches.size(); ++j) {
            const auto& b = batches[j];
            for (int z = 0; z < b.dimensions[2]; ++z) {
                for (int y = 0; y < b.dimensions[1]; ++y) {
                    for (int x = 0; x < b.dimensions[0]; ++x) {
                        const size_t local = j * 128 + 2 * (x + y * b.dimensions[0] + z * b.dimensions[0] * b.dimensions[1]);
                        output.set_mask(output.block_index({ b.origin[0] + x, b.origin[1] + y, b.origin[2] + z }), uint64_t(masks[local]) | (uint64_t(masks[local + 1]) << 32));
                    }
                }
            }
        }
        return output;
    }
    Grid dilate(const Grid& grid, Eigen::Vector3i radius) const override {
        std::vector<uint32_t> packed;
        const auto active = grid.active_blocks();
        packed.reserve(active.size() * 3);
        for (auto index : active) {
            const auto bits = grid.mask(index);
            packed.insert(packed.end(), { index, uint32_t(bits), uint32_t(bits >> 32) });
        }
        const auto masks = gpu::dilate_blocks(packed, { uint32_t(grid.size[0]), uint32_t(grid.size[1]), uint32_t(grid.size[2]) },
            { uint32_t(radius[0]), uint32_t(radius[1]), uint32_t(radius[2]) });
        Grid output(grid.size);
        for (uint32_t index = 0; index < grid.block_count(); ++index) {
            output.set_mask(index, uint64_t(masks[index * 2]) | (uint64_t(masks[index * 2 + 1]) << 32));
        }
        return output;
    }
};
} // namespace

const Backend& gpu_backend() {
    static const GpuBackend backend;
    return backend;
}
} // namespace splat_transform::voxel
