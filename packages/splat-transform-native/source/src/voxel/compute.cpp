#include "compute.h"
#include "candidate_count.h"
#include "candidate_scatter.h"
#include "compact.h"
#include "dilate.h"
#include "expand.h"
#include "gpu_workspace.h"
#include <algorithm>
#include <gpu/compute.h>
#include <numeric>
#include <stdexcept>
#include <voxelize.h>

namespace splat_transform::voxel {
using enum gpu::BufferAccess;
struct VoxelSession::Impl {
    GpuWorkspace work;
};
VoxelSession::VoxelSession() : impl_(std::make_unique<Impl>()) {}
VoxelSession::~VoxelSession() = default;
std::vector<uint32_t> VoxelSession::voxelize(std::span<const Gaussian> gaussians, std::span<const uint32_t> indices, std::span<const VoxelBatch> batches,
    float resolution, float cutoff, uint32_t max_blocks) {
    if (batches.empty()) {
        return {};
    }
    if (!max_blocks) {
        throw std::runtime_error("Voxel dispatch must contain at least one block");
    }
    struct Parameters {
        float resolution;
        float cutoff;
        uint32_t max_blocks;
        uint32_t accumulation;
        uint32_t first_block;
    };
    static_assert(sizeof(Parameters) == 20);
    auto& work = impl_->work;
    const auto& device = work.device();
    const size_t storage = device.limits().storage_buffer_bytes;
    const size_t words = batches.size() * max_blocks * 2;
    std::vector<uint32_t> output(words);
    const auto execute = [&](std::span<const Gaussian> points, std::span<const uint32_t> local_indices, std::span<const VoxelBatch> local_batches,
                             Parameters parameters, std::span<const std::byte> previous, std::span<uint32_t> result, bool reuse_inputs = false) {
        const uint64_t end_block = uint64_t(parameters.first_block) + parameters.max_blocks;
        const bool padded = std::ranges::any_of(local_batches, [&](const auto& batch) {
            return uint64_t(batch.blocks_x) * batch.blocks_y * batch.blocks_z < end_block;
        });
        work.execute({ "voxelize", shaders::voxelize, { Read, Read, Read, ReadWrite }, sizeof(Parameters), { { 0, parameters.accumulation || parameters.first_block ? 1u : 0u } } },
            { { std::as_bytes(points), 0, {}, reuse_inputs }, { std::as_bytes(local_indices), 0, {}, reuse_inputs }, { std::as_bytes(local_batches), 0 }, { previous, result.size_bytes(), std::as_writable_bytes(result), false, padded } },
            std::as_bytes(std::span(&parameters, 1)), { parameters.max_blocks, 1, uint32_t(local_batches.size()) });
    };
    if (gaussians.size_bytes() <= storage && indices.size_bytes() <= storage && batches.size_bytes() <= storage &&
        words <= storage / 4 && max_blocks <= device.limits().workgroup_count[0] && batches.size() <= device.limits().workgroup_count[2]) {
        execute(gaussians, indices, batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, output);
        return output;
    }

    const size_t point_limit = storage / sizeof(Gaussian);
    const size_t batch_limit = std::min({ storage / sizeof(VoxelBatch), storage / (size_t(max_blocks) * 8), size_t(device.limits().workgroup_count[2]) });
    const size_t block_limit = std::min<size_t>(storage / (64 * 4), device.limits().workgroup_count[0]);
    if (!point_limit || !block_limit) {
        throw std::runtime_error("GPU limits cannot hold one voxel workgroup");
    }
    // When only the dispatch/output needs splitting, keep the original input
    // buffers resident instead of duplicating candidates into packed arrays.
    if (gaussians.size_bytes() <= storage && indices.size_bytes() <= storage && batch_limit && max_blocks <= device.limits().workgroup_count[0]) {
        for (size_t begin = 0; begin < batches.size(); begin += batch_limit) {
            const auto local_batches = batches.subspan(begin, std::min(batch_limit, batches.size() - begin));
            const size_t local_words = local_batches.size() * max_blocks * 2;
            execute(gaussians, indices, local_batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, std::span(output).subspan(begin * max_blocks * 2, local_words), begin != 0);
        }
        return output;
    }
    std::vector<Gaussian> packed;
    std::vector<uint32_t> local_indices;
    std::vector<VoxelBatch> local_batches;
    const auto pack = [&](const VoxelBatch& batch, size_t begin, size_t count) {
        if (uint64_t(batch.index_offset) + batch.index_count > indices.size()) {
            throw std::runtime_error("Voxel batch references unavailable candidate indices");
        }
        for (size_t i = 0; i < count; ++i) {
            const auto index = indices[size_t(batch.index_offset) + begin + i];
            if (index >= gaussians.size()) {
                throw std::runtime_error("Voxel candidate references an unavailable Gaussian");
            }
            local_indices.push_back(uint32_t(packed.size()));
            packed.push_back(gaussians[index]);
        }
    };
    for (size_t begin = 0; begin < batches.size();) {
        packed.clear();
        local_indices.clear();
        local_batches.clear();
        // Compact only the candidates referenced by this dispatch. Unrelated
        // Gaussians need not fit in a device buffer, even for a large scene.
        if (max_blocks <= device.limits().workgroup_count[0]) {
            for (size_t i = begin; i < batches.size() && local_batches.size() < batch_limit; ++i) {
                const auto& batch = batches[i];
                if (batch.index_count > point_limit - packed.size()) {
                    break;
                }
                auto local = batch;
                local.index_offset = uint32_t(packed.size());
                pack(batch, 0, batch.index_count);
                local_batches.push_back(local);
            }
        }
        if (!local_batches.empty()) {
            const size_t local_words = local_batches.size() * max_blocks * 2;
            execute(packed, local_indices, local_batches, { resolution, cutoff, max_blocks, 0, 0 }, {}, std::span(output).subspan(begin * max_blocks * 2, local_words));
            begin += local_batches.size();
            continue;
        }

        // A single dense batch can also exceed the Gaussian buffer limit.
        // Carry float densities between chunks and threshold only the final
        // chunk, preserving candidate order and the shader's saturation rule.
        const auto& batch = batches[begin];
        for (size_t block = 0; block < max_blocks; block += block_limit) {
            const auto block_count = uint32_t(std::min<size_t>(block_limit, max_blocks - block));
            std::vector<uint32_t> state;
            for (size_t point = 0; point < std::max<size_t>(batch.index_count, 1); point += point_limit) {
                const size_t count = std::min<size_t>(point_limit, batch.index_count - point);
                const bool last = point + count == batch.index_count;
                const uint32_t accumulation = (point ? 1u : 0u) | (last ? 0u : 2u);
                packed.clear();
                local_indices.clear();
                pack(batch, point, count);
                auto local = batch;
                local.index_offset = 0;
                local.index_count = uint32_t(count);
                const size_t stride = accumulation ? 64 : 2;
                state.resize(size_t(block_count) * stride);
                execute(packed, local_indices, std::span(&local, 1),
                    { resolution, cutoff, block_count, accumulation, uint32_t(block) }, point ? std::as_bytes(std::span(state)) : std::span<const std::byte> {}, state);
                if (last) {
                    for (size_t i = 0; i < block_count; ++i) {
                        std::copy_n(state.data() + i * stride, 2, output.data() + (begin * max_blocks + block + i) * 2);
                    }
                }
            }
        }
        ++begin;
    }
    return output;
}
CandidateBins VoxelSession::candidates(std::span<const Gaussian> gaussians, std::array<float, 3> origin, float batch_size, std::array<uint32_t, 3> dimensions) {
    const uint64_t plane = uint64_t(dimensions[0]) * dimensions[1];
    if ((dimensions[2] && plane > UINT32_MAX / dimensions[2]) || gaussians.size() > UINT32_MAX) {
        throw std::runtime_error("Voxel candidate grid exceeds 32-bit indexing");
    }
    const size_t bin_count = size_t(plane * dimensions[2]);
    CandidateBins output;
    output.counts.resize(size_t(bin_count));
    output.offsets.resize(size_t(bin_count));
    if (gaussians.empty() || !bin_count) {
        return output;
    }
    struct Parameters {
        std::array<float, 3> origin;
        float size;
        std::array<uint32_t, 3> dimensions;
        uint32_t count;
        uint32_t groups_x;
        uint32_t first_bin;
        uint32_t bin_count;
        uint32_t first_point;
    };
    auto& work = impl_->work;
    const auto& device = work.device();
    const size_t point_limit = std::min(device.limits().storage_buffer_bytes / sizeof(Gaussian), device.linear_item_limit(128));
    const size_t index_limit = device.limits().storage_buffer_bytes / sizeof(uint32_t);
    if (!point_limit || !index_limit) {
        throw std::runtime_error("GPU limits cannot hold one voxel candidate");
    }
    bool split_full_input = false;
    if (gaussians.size() <= point_limit && bin_count <= index_limit) {
        // Preserve the one-dispatch path on devices with a large buffer range.
        // Count and scatter share the same uploaded Gaussian buffer.
        const auto groups = device.linear_groups(gaussians.size(), 128);
        const Parameters parameters { origin, batch_size, dimensions, uint32_t(gaussians.size()), groups[0], 0, uint32_t(bin_count), 0 };
        const auto push = std::as_bytes(std::span(&parameters, 1));
        work.execute({ "candidate_count", shaders::candidate_count, { Read, ReadWrite }, sizeof(Parameters) },
            { { std::as_bytes(gaussians), 0 }, { {}, bin_count * 4, std::as_writable_bytes(std::span(output.counts)) } }, push, groups);
        uint64_t total = 0;
        for (size_t i = 0; i < bin_count; ++i) {
            output.offsets[i] = uint32_t(total);
            total += output.counts[i];
            if (total > UINT32_MAX) {
                throw std::runtime_error("Voxel candidates exceed 32-bit indexing");
            }
        }
        if (!total) {
            return output;
        }
        if (total <= index_limit) {
            output.indices.resize(size_t(total));
            work.execute({ "candidate_scatter", shaders::candidate_scatter, { Read, Read, ReadWrite, ReadWrite }, sizeof(Parameters) },
                { { std::as_bytes(gaussians), 0, {}, true }, { std::as_bytes(std::span(output.offsets)), 0 }, { {}, bin_count * 4 }, { {}, size_t(total) * 4, std::as_writable_bytes(std::span(output.indices)), false, false } }, push, groups);
            return output;
        }
        split_full_input = true;
        std::fill(output.counts.begin(), output.counts.end(), 0);
    }
    struct Range {
        uint32_t bin;
        uint32_t offset;
        uint32_t count;
    };
    struct Part {
        std::vector<Range> ranges;
        std::vector<uint32_t> indices;
    };
    std::vector<Part> parts;
    uint64_t total_indices = 0;
    const auto process = [&](auto&& self, size_t first_point, size_t point_count, size_t first_bin, size_t bins) -> void {
        const auto points = gaussians.subspan(first_point, point_count);
        const auto groups = device.linear_groups(point_count, 128);
        const Parameters parameters { origin, batch_size, dimensions, uint32_t(point_count), groups[0], uint32_t(first_bin), uint32_t(bins), uint32_t(first_point) };
        static_assert(sizeof(Parameters) == 48);
        const uint32_t windowed = first_bin || bins != bin_count ? 1 : 0;
        const auto push = std::as_bytes(std::span(&parameters, 1));
        std::vector<uint32_t> counts(bins);
        work.execute({ "candidate_count", shaders::candidate_count, { Read, ReadWrite }, sizeof(Parameters), { { 0, windowed } } },
            { { std::as_bytes(points), 0 }, { {}, bins * 4, std::as_writable_bytes(std::span(counts)) } }, push, groups);
        const uint64_t total = std::accumulate(counts.begin(), counts.end(), uint64_t(0));
        if (!total) {
            return;
        }
        if (total > index_limit) {
            // Overlap can make scatter output larger than either input. Split
            // again using the measured count, including the one-point case.
            std::vector<uint32_t>().swap(counts);
            if (point_count > 1) {
                const size_t half = point_count / 2;
                self(self, first_point, half, first_bin, bins);
                self(self, first_point + half, point_count - half, first_bin, bins);
            } else {
                const size_t half = bins / 2;
                self(self, first_point, point_count, first_bin, half);
                self(self, first_point, point_count, first_bin + half, bins - half);
            }
            return;
        }
        total_indices += total;
        if (total_indices > UINT32_MAX) {
            throw std::runtime_error("Voxel candidates exceed 32-bit indexing");
        }
        Part part;
        uint32_t offset = 0;
        for (size_t i = 0; i < bins; ++i) {
            const auto count = counts[i];
            counts[i] = offset;
            if (count) {
                part.ranges.push_back({ uint32_t(first_bin + i), offset, count });
                output.counts[first_bin + i] += count;
                offset += count;
            }
        }
        part.indices.resize(size_t(total));
        work.execute({ "candidate_scatter", shaders::candidate_scatter, { Read, Read, ReadWrite, ReadWrite }, sizeof(Parameters), { { 0, windowed | (first_point ? 2u : 0u) } } },
            { { std::as_bytes(points), 0, {}, true }, { std::as_bytes(std::span(counts)), 0 }, { {}, bins * 4 }, { {}, size_t(total) * 4, std::as_writable_bytes(std::span(part.indices)), false, false } }, push, groups);
        parts.push_back(std::move(part));
    };
    if (split_full_input) {
        const size_t half = gaussians.size() / 2;
        process(process, 0, half, 0, bin_count);
        process(process, half, gaussians.size() - half, 0, bin_count);
    } else {
        for (size_t bin = 0; bin < bin_count; bin += index_limit) {
            for (size_t point = 0; point < gaussians.size(); point += point_limit) {
                process(process, point, std::min(point_limit, gaussians.size() - point), bin, std::min(index_limit, bin_count - bin));
            }
        }
    }
    uint32_t offset = 0;
    for (size_t i = 0; i < output.counts.size(); ++i) {
        output.offsets[i] = offset;
        offset += output.counts[i];
    }
    if (parts.size() == 1) {
        output.indices = std::move(parts.front().indices);
    } else {
        output.indices.resize(size_t(total_indices));
        for (auto& part : parts) {
            for (const auto& range : part.ranges) {
                std::copy_n(part.indices.data() + range.offset, range.count, output.indices.data() + output.offsets[range.bin]);
                output.offsets[range.bin] += range.count;
            }
            std::vector<uint32_t>().swap(part.indices);
        }
        for (size_t i = 0; i < bin_count; ++i) {
            output.offsets[i] -= output.counts[i];
        }
    }
    return output;
}
std::vector<uint32_t> VoxelSession::dilate_blocks(std::span<const uint32_t> blocks, std::array<uint32_t, 3> dimensions, std::array<uint32_t, 3> radii) {
    if (std::ranges::any_of(dimensions, [](uint32_t size) { return !size || size % 4; }) || blocks.size() % 3) {
        throw std::runtime_error("Invalid GPU dilation grid or packed blocks");
    }
    const uint64_t plane = uint64_t(dimensions[0]) * dimensions[1];
    if (plane > UINT32_MAX / dimensions[2]) {
        throw std::runtime_error("GPU dilation grid exceeds 32-bit indexing");
    }
    const uint64_t cells = plane * dimensions[2], block_count = cells / 64;
    const size_t dense_bytes = size_t((cells + 31) / 32) * 4;
    auto& work = impl_->work;
    const auto& device = work.device();
    for (size_t axis = 0; axis < 3; ++axis) {
        radii[axis] = std::min(radii[axis], dimensions[axis] - 1);
    }
    const auto execute = [&](std::span<const uint32_t> packed, std::array<uint32_t, 3> size) {
        const size_t count = size_t(size[0]) * size[1] * size[2] / 64;
        const size_t bytes = count * 8;
        const auto expand_groups = device.linear_groups(packed.size() / 3, 128);
        const auto compact_groups = device.linear_groups(count, 128);
        const auto dilate_groups = device.linear_groups(bytes / 4, 128);
        std::array<uint32_t, 5> expand { size[0], size[1], size[2], uint32_t(packed.size() / 3), expand_groups[0] };
        std::array<uint32_t, 5> compact { size[0], size[1], size[2], uint32_t(count), compact_groups[0] };
        std::array<std::array<uint32_t, 7>, 3> dilation;
        std::vector<ComputeStage> stages;
        stages.push_back({ { "expand", shaders::expand, { Read, ReadWrite }, sizeof(expand) }, { 0, 1 }, std::as_bytes(std::span(expand)), expand_groups });
        uint32_t current = 1, next = 2;
        for (size_t axis = 0; axis < 3; ++axis) {
            if (radii[axis]) {
                dilation[axis] = { size[0], size[1], size[2], 0, 0, 0, dilate_groups[0] };
                dilation[axis][3 + axis] = std::min(radii[axis], size[axis] - 1);
                stages.push_back({ { "dilate", shaders::dilate, { Read, ReadWrite }, sizeof(dilation[axis]) }, { current, next }, std::as_bytes(std::span(dilation[axis])), dilate_groups });
                std::swap(current, next);
            }
        }
        stages.push_back({ { "compact", shaders::compact, { Read, ReadWrite }, sizeof(compact) }, { current, 3 }, std::as_bytes(std::span(compact)), compact_groups });
        std::vector<uint32_t> output(count * 2);
        work.execute_chain({ { std::as_bytes(packed), 0 }, { {}, bytes }, { {}, bytes, {}, false, false }, { {}, count * 8, std::as_writable_bytes(std::span(output)), false, false } }, stages);
        return output;
    };
    if (blocks.size_bytes() <= device.limits().storage_buffer_bytes && dense_bytes <= device.limits().storage_buffer_bytes &&
        blocks.size() / 3 <= device.linear_item_limit(128) && dense_bytes / 4 <= device.linear_item_limit(128)) {
        return execute(blocks, dimensions);
    }

    std::array<uint32_t, 3> grid { dimensions[0] / 4, dimensions[1] / 4, dimensions[2] / 4 };
    std::array<uint32_t, 3> minimum = grid, maximum {};
    std::vector<uint32_t> source(size_t(block_count) * 2);
    std::vector<uint32_t> output(source.size());
    for (size_t i = 0; i < blocks.size(); i += 3) {
        const auto index = blocks[i];
        if (index >= block_count) {
            throw std::runtime_error("GPU dilation references an unavailable block");
        }
        if (!(blocks[i + 1] | blocks[i + 2])) {
            continue;
        }
        source[size_t(index) * 2] |= blocks[i + 1];
        source[size_t(index) * 2 + 1] |= blocks[i + 2];
        const std::array<uint32_t, 3> point { index % grid[0], index / grid[0] % grid[1], index / (grid[0] * grid[1]) };
        for (size_t axis = 0; axis < 3; ++axis) {
            minimum[axis] = std::min(minimum[axis], point[axis]);
            maximum[axis] = std::max(maximum[axis], point[axis] + 1);
        }
    }
    if (!maximum[0]) {
        return output;
    }
    std::array<uint32_t, 3> halo, tile;
    for (size_t axis = 0; axis < 3; ++axis) {
        halo[axis] = (radii[axis] + 3) / 4;
        minimum[axis] -= std::min(minimum[axis], halo[axis]);
        maximum[axis] = std::min(grid[axis], maximum[axis] + halo[axis]);
        tile[axis] = maximum[axis] - minimum[axis];
    }
    // Reserve enough space for even a fully occupied tile's packed input.
    // Halos provide all neighbors for the three separable dilation passes.
    const size_t tile_limit = std::min(device.limits().storage_buffer_bytes / 12, device.linear_item_limit(128) / 2);
    const auto padded_count = [&] {
        uint64_t count = 1;
        for (size_t axis = 0; axis < 3; ++axis) {
            count *= std::min(grid[axis], tile[axis] + 2 * halo[axis]);
        }
        return count;
    };
    while (padded_count() > tile_limit) {
        const auto largest = std::max_element(tile.begin(), tile.end());
        if (*largest <= 1) {
            throw std::runtime_error("GPU storage limit cannot hold the dilation neighborhood");
        }
        *largest = (*largest + 1) / 2;
    }
    std::vector<uint32_t> packed;
    for (uint32_t z = minimum[2]; z < maximum[2]; z += tile[2]) {
        for (uint32_t y = minimum[1]; y < maximum[1]; y += tile[1]) {
            for (uint32_t x = minimum[0]; x < maximum[0]; x += tile[0]) {
                const std::array<uint32_t, 3> begin { x, y, z };
                std::array<uint32_t, 3> end, low, high, size;
                for (size_t axis = 0; axis < 3; ++axis) {
                    end[axis] = std::min(maximum[axis], begin[axis] + tile[axis]);
                    low[axis] = begin[axis] - std::min(begin[axis], halo[axis]);
                    high[axis] = std::min(grid[axis], end[axis] + halo[axis]);
                    size[axis] = high[axis] - low[axis];
                }
                packed.clear();
                for (uint32_t iz = low[2]; iz < high[2]; ++iz) {
                    for (uint32_t iy = low[1]; iy < high[1]; ++iy) {
                        for (uint32_t ix = low[0]; ix < high[0]; ++ix) {
                            const size_t index = size_t(ix) + size_t(iy) * grid[0] + size_t(iz) * grid[0] * grid[1];
                            if (source[index * 2] | source[index * 2 + 1]) {
                                const uint32_t local = ix - low[0] + (iy - low[1]) * size[0] + (iz - low[2]) * size[0] * size[1];
                                packed.insert(packed.end(), { local, source[index * 2], source[index * 2 + 1] });
                            }
                        }
                    }
                }
                if (packed.empty()) {
                    continue;
                }
                const auto masks = execute(packed, { size[0] * 4, size[1] * 4, size[2] * 4 });
                for (uint32_t iz = begin[2]; iz < end[2]; ++iz) {
                    for (uint32_t iy = begin[1]; iy < end[1]; ++iy) {
                        const size_t global = size_t(begin[0]) + size_t(iy) * grid[0] + size_t(iz) * grid[0] * grid[1];
                        const size_t local = begin[0] - low[0] + size_t(iy - low[1]) * size[0] + size_t(iz - low[2]) * size[0] * size[1];
                        std::copy_n(masks.data() + local * 2, size_t(end[0] - begin[0]) * 2, output.data() + global * 2);
                    }
                }
            }
        }
    }
    return output;
}
} // namespace splat_transform::voxel
