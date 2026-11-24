#include "emeans_gpu.h"
#include "cluster_gpu.h"
#include <bit>
#include <emeans_bin.h>
#include <emeans_offsets.h>
#include <emeans_reduce.h>
#include <emeans_split.h>
#include <emeans_update.h>

namespace splat_transform::spatial {
namespace {
using enum gpu::BufferAccess;
using enum gpu::BufferMemory;
using Centers = decltype(Clustering::centroids);
enum Update : uint32_t { Initialize,
    Train,
    LastEpoch,
    Finish };

template<typename... Buffers>
gpu::DescriptorTable table(const gpu::ComputeDevice& device, const gpu::ComputePipeline& pipeline, const Buffers&... buffers) {
    return device.create_descriptor_table(pipeline, std::array { gpu::BufferRange { &buffers }... });
}

template<size_t Size>
void dispatch(gpu::CommandList& commands, const gpu::ComputePipeline& pipeline, const gpu::DescriptorTable& bindings,
    std::array<uint32_t, 3> groups, const std::array<uint32_t, Size>& parameters) {
    commands.bind_pipeline(pipeline);
    commands.bind_descriptor_table(bindings);
    commands.push_constants(std::as_bytes(std::span(parameters)));
    commands.dispatch(groups);
}
} // namespace

struct EmeansGpu::Impl {
    gpu::ComputeDevice device;
    gpu::Queue& queue = device.default_queue();
    gpu::Fence fence = device.create_fence();
    std::span<const uint32_t> order;
    size_t columns, stride, capacity, chunk_rows;
    uint32_t active = 0;
    gpu::Buffer labels, centers, state, sums, closing, bins, members, pairs, upload, readback;
    gpu::ComputePipeline assignment, binning, offsets, reduce, update, splitting;
    gpu::DescriptorTable bin_table, offset_table, update_table, split_table;
    struct Chunk {
        gpu::Buffer points;
        gpu::DescriptorTable assignment, reduce;
        uint32_t rows;
    };
    std::vector<Chunk> chunks;
    gpu::CommandList commands = device.create_commands();

    Impl(FeatureView points, std::span<const float> weights, std::span<const uint32_t> permutation, size_t max_count, size_t requested_chunk)
        : order(permutation), columns(points.dimensions()), stride((columns + 3) / 4 * 4), capacity(max_count) {
        if (!capacity || capacity > 262144 || !points.rows() || order.size() != points.rows() || weights.size() != order.size() || !requested_chunk ||
            std::ranges::any_of(order, [&](auto row) { return row >= points.rows(); })) {
            throw std::invalid_argument("Invalid e-means GPU input");
        }
        const size_t row_bytes = (stride + 1) * sizeof(float);
        const auto& limits = device.limits();
        chunk_rows = std::min({ order.size(), requested_chunk, limits.storage_buffer_bytes / row_bytes, static_cast<size_t>(limits.workgroup_count[0]) * 128 });
        if (!chunk_rows || capacity > limits.storage_buffer_bytes / row_bytes || order.size() > limits.storage_buffer_bytes / sizeof(uint32_t)) {
            throw gpu::AllocationFailure("e-means buffers exceed the storage binding limit");
        }
        auto storage = [&](size_t bytes) { return device.create_buffer(bytes, Device, true); };
        labels = storage(order.size_bytes());
        centers = storage(capacity * stride * sizeof(float));
        state = storage(2 * capacity * sizeof(float));
        sums = storage(capacity * row_bytes);
        closing = storage(sums.size());
        bins = storage((2 * capacity + 1) * sizeof(uint32_t));
        members = storage(chunk_rows * sizeof(uint32_t));
        pairs = storage(std::max<size_t>(1, capacity / 2) * sizeof(Split));
        upload = device.create_buffer(centers.size(), Upload);
        readback = device.create_buffer(centers.size() + labels.size(), Readback);
        assignment = make_cluster_pipeline(device, stride, cluster_tile(device, stride));
        binning = device.create_pipeline({ "emeans-bin", shaders::emeans_bin, { Read, ReadWrite, ReadWrite }, 12 });
        offsets = device.create_pipeline({ "emeans-offsets", shaders::emeans_offsets, { ReadWrite }, 4 });
        reduce = device.create_pipeline({ "emeans-reduce", shaders::emeans_reduce, { Read, Read, Read, ReadWrite }, 20 });
        update = device.create_pipeline({ "emeans-update", shaders::emeans_update, { Read, ReadWrite, ReadWrite, ReadWrite }, 16 });
        splitting = device.create_pipeline({ "emeans-split", shaders::emeans_split, { Read, ReadWrite, ReadWrite }, 12 });
        bin_table = table(device, binning, labels, bins, members);
        offset_table = table(device, offsets, bins);
        update_table = table(device, update, sums, closing, centers, state);
        split_table = table(device, splitting, pairs, centers, state);
        auto staging = device.create_buffer(chunk_rows * row_bytes, Upload);
        commands.begin();
        for (size_t first = 0; first < order.size(); first += chunk_rows) {
            const auto count = std::min(chunk_rows, order.size() - first);
            auto& chunk = chunks.emplace_back();
            chunk.rows = static_cast<uint32_t>(count);
            chunk.points = storage(count * row_bytes);
            chunk.assignment = table(device, assignment, chunk.points, centers, state, labels);
            chunk.reduce = table(device, reduce, chunk.points, bins, members, sums);
            pack_cluster_points(staging, points, order, first, count, stride, weights);
            commands.copy(staging, chunk.points, chunk.points.size());
            sync();
        }
    }

    void sync() {
        commands.end();
        const auto value = queue.submit(commands, fence);
        try {
            queue.wait_cpu(fence, value);
        } catch (...) {
            queue.wait_cpu();
            throw;
        }
        commands.reset();
        commands.begin();
    }

    void update_centers(Update mode, float alpha) {
        dispatch(commands, update, update_table, device.linear_groups(active, 128),
            std::array { active, static_cast<uint32_t>(stride), std::bit_cast<uint32_t>(alpha), static_cast<uint32_t>(mode) });
    }

    void begin(const Centers& seeds) {
        if (active || seeds.cols() != static_cast<Eigen::Index>(columns) || seeds.rows() <= 0 || static_cast<size_t>(seeds.rows()) > capacity) {
            throw std::invalid_argument("Invalid e-means seeds");
        }
        active = static_cast<uint32_t>(seeds.rows());
        auto* packed = reinterpret_cast<float*>(upload.mapped_data());
        for (size_t entry = 0; entry < active; ++entry) {
            std::copy_n(seeds.row(entry).data(), columns, packed);
            std::fill(packed + columns, packed + stride, 0.0f);
            packed += stride;
        }
        upload.flush();
        commands.copy(upload, centers, active * stride * sizeof(float));
        commands.fill(closing, 0, active * (stride + 1) * sizeof(float));
        update_centers(Initialize, 0);
    }

    void batch(size_t first, size_t count, float alpha, bool last) {
        if (!active || first >= order.size() || !count || count > order.size() || !(alpha > 0 && alpha <= 1)) {
            throw std::invalid_argument("Invalid e-means batch");
        }
        commands.fill(sums, 0, active * (stride + 1) * sizeof(float));
        const auto groups_y = 1 + (active - 1) / device.limits().workgroup_count[0];
        const auto groups_x = 1 + (active - 1) / groups_y;
        const std::array reduce_groups { groups_x, groups_y, 1u };
        while (count) {
            auto& chunk = chunks[first / chunk_rows];
            const auto offset = static_cast<uint32_t>(first % chunk_rows);
            const auto length = static_cast<uint32_t>(std::min<size_t>(count, chunk.rows - offset));
            const auto global = static_cast<uint32_t>(first);
            dispatch_cluster(commands, assignment, chunk.assignment, length, active, offset, global);
            commands.fill(bins, 0, (2 * active + 1) * sizeof(uint32_t));
            const auto point_groups = device.linear_groups(length, 128);
            dispatch(commands, binning, bin_table, point_groups, std::array { length, global, 0u });
            dispatch(commands, offsets, offset_table, device.linear_groups(active, 128), std::array { active });
            dispatch(commands, binning, bin_table, point_groups, std::array { length, global, 1u });
            dispatch(commands, reduce, chunk.reduce, reduce_groups,
                std::array { active, static_cast<uint32_t>(stride), offset, static_cast<uint32_t>(chunk.rows * stride), groups_x });
            first += length;
            if (first == order.size()) {
                first = 0;
            }
            count -= length;
        }
        update_centers(last ? LastEpoch : Train, alpha);
    }

    void read_usage(std::span<float> usage) {
        if (!active || usage.size() != active) {
            throw std::invalid_argument("Invalid e-means usage size");
        }
        commands.copy(state, readback, usage.size_bytes(), usage.size_bytes());
        sync();
        readback.read_into(std::as_writable_bytes(usage));
    }

    void split(std::span<const Split> splits) {
        if (splits.empty()) {
            return;
        }
        if (splits.size() > active / 2) {
            throw std::invalid_argument("Invalid e-means split count");
        }
        upload.upload(std::as_bytes(splits));
        commands.copy(upload, pairs, splits.size_bytes());
        const auto count = static_cast<uint32_t>(splits.size());
        dispatch(commands, splitting, split_table, device.linear_groups(count, 128), std::array { count, static_cast<uint32_t>(stride), active });
    }

    Clustering finish() {
        if (!active) {
            throw std::logic_error("Missing e-means training pass");
        }
        update_centers(Finish, 0);
        std::vector<float> packed(active * stride);
        auto center_bytes = std::as_writable_bytes(std::span(packed));
        commands.copy(centers, readback, center_bytes.size());
        commands.copy(labels, readback, labels.size(), 0, center_bytes.size());
        sync();
        readback.read_into(center_bytes);
        std::vector<uint32_t> shuffled(order.size());
        readback.read_into(std::as_writable_bytes(std::span(shuffled)), center_bytes.size());
        Clustering result { Centers(active, columns), std::vector<uint32_t>(order.size()) };
        for (size_t entry = 0; entry < active; ++entry) {
            std::copy_n(packed.data() + entry * stride, columns, result.centroids.row(entry).data());
        }
        for (size_t row = 0; row < order.size(); ++row) {
            result.labels[order[row]] = shuffled[row];
        }
        active = 0;
        return result;
    }
};

EmeansGpu::EmeansGpu(FeatureView points, std::span<const float> weights, std::span<const uint32_t> order, size_t capacity, size_t chunk_rows)
    : impl_(std::make_unique<Impl>(points, weights, order, capacity, chunk_rows)) {}
EmeansGpu::~EmeansGpu() = default;
void EmeansGpu::begin(const Centers& seeds) { impl_->begin(seeds); }
void EmeansGpu::batch(size_t first, size_t count, float alpha, bool closing) { impl_->batch(first, count, alpha, closing); }
void EmeansGpu::revive(std::span<float> usage, SplitSelector choose) {
    impl_->read_usage(usage);
    impl_->split(choose(usage));
}
Clustering EmeansGpu::finish() { return impl_->finish(); }
} // namespace splat_transform::spatial
