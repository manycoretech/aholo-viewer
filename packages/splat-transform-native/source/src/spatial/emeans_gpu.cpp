#include "emeans_gpu.h"
#include "cluster_gpu.h"
#include <bit>
#include <emeans_assign.h>
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
enum Update : uint32_t {
    Initialize,
    Train,
    LastEpoch,
    Finish
};

template<typename... Buffers>
gpu::DescriptorTable table(
    const gpu::ComputeDevice& device, const gpu::ComputePipeline& pipeline, const Buffers&... buffers
) {
    return device.create_descriptor_table(pipeline, std::array { gpu::BufferRange { &buffers }... });
}

template<size_t Size>
void dispatch(
    gpu::CommandList& commands, const gpu::ComputePipeline& pipeline, const gpu::DescriptorTable& bindings,
    std::array<uint32_t, 3> groups, const std::array<uint32_t, Size>& parameters
) {
    commands.bind_pipeline(pipeline);
    commands.bind_descriptor_table(bindings);
    commands.push_constants(std::as_bytes(std::span(parameters)));
    commands.dispatch(groups);
}
} // namespace

struct EmeansGpu::Impl {
    gpu::ComputeDevice device;
    gpu::Queue& queue = this->device.default_queue();
    gpu::Fence fence = this->device.create_fence();
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
    gpu::CommandList commands = this->device.create_commands();

    Impl(
        FeatureView points, std::span<const float> weights, std::span<const uint32_t> permutation, size_t max_count,
        size_t requested_chunk
    )
        : order(permutation), columns(points.dimensions()), stride((this->columns + 3) / 4 * 4), capacity(max_count),
          chunk_rows(std::min(points.rows(), requested_chunk)) {
        if (!this->capacity || this->capacity > 262144 || !this->columns || !this->chunk_rows ||
            this->order.size() != points.rows() || weights.size() != this->order.size()) {
            throw std::invalid_argument("Invalid e-means GPU input");
        }
        const size_t row_bytes = (this->stride + 1) * sizeof(float);
        const auto& limits = this->device.limits();
        this->chunk_rows = std::min(
            { this->chunk_rows, limits.storage_buffer_bytes / row_bytes,
                static_cast<size_t>(limits.workgroup_count[0]) * 128 }
        );
        if (!this->chunk_rows || this->capacity > limits.storage_buffer_bytes / row_bytes ||
            this->order.size() > limits.storage_buffer_bytes / sizeof(uint32_t)) {
            throw gpu::AllocationFailure("e-means buffers exceed the storage binding limit");
        }
        auto storage = [&](size_t bytes) { return this->device.create_buffer(bytes, Device, true); };
        this->labels = storage(this->order.size_bytes());
        this->centers = storage(this->capacity * this->stride * sizeof(float));
        this->state = storage(2 * this->capacity * sizeof(float));
        this->sums = storage(this->capacity * row_bytes);
        this->closing = storage(this->sums.size());
        this->bins = storage((2 * this->capacity + 1) * sizeof(uint32_t));
        this->members = storage(this->chunk_rows * sizeof(uint32_t));
        this->pairs = storage(std::max<size_t>(1, this->capacity / 2) * sizeof(Split));
        this->upload = this->device.create_buffer(this->centers.size(), Upload);
        this->readback = this->device.create_buffer(this->centers.size() + this->labels.size(), Readback);
        this->assignment = this->device.create_pipeline(
            { "emeans-assign", shaders::emeans_assign, { Read, Read, Read, ReadWrite }, 16,
                { { 0, static_cast<uint32_t>(this->stride / 4) } } }
        );
        this->binning =
            this->device.create_pipeline({ "emeans-bin", shaders::emeans_bin, { Read, ReadWrite, ReadWrite }, 12 });
        this->offsets = this->device.create_pipeline({ "emeans-offsets", shaders::emeans_offsets, { ReadWrite }, 4 });
        this->reduce = this->device.create_pipeline(
            { "emeans-reduce", shaders::emeans_reduce, { Read, Read, Read, ReadWrite }, 20 }
        );
        this->update = this->device.create_pipeline(
            { "emeans-update", shaders::emeans_update, { Read, ReadWrite, ReadWrite, ReadWrite }, 16 }
        );
        this->splitting =
            this->device.create_pipeline({ "emeans-split", shaders::emeans_split, { Read, ReadWrite, ReadWrite }, 12 });
        this->bin_table = table(this->device, this->binning, this->labels, this->bins, this->members);
        this->offset_table = table(this->device, this->offsets, this->bins);
        this->update_table = table(this->device, this->update, this->sums, this->closing, this->centers, this->state);
        this->split_table = table(this->device, this->splitting, this->pairs, this->centers, this->state);
        auto staging = this->device.create_buffer(this->chunk_rows * row_bytes, Upload);
        this->commands.begin();
        for (size_t first = 0; first < this->order.size(); first += this->chunk_rows) {
            const auto count = std::min(this->chunk_rows, this->order.size() - first);
            auto& chunk = this->chunks.emplace_back();
            chunk.rows = static_cast<uint32_t>(count);
            chunk.points = storage(count * row_bytes);
            chunk.assignment =
                table(this->device, this->assignment, chunk.points, this->centers, this->state, this->labels);
            chunk.reduce = table(this->device, this->reduce, chunk.points, this->bins, this->members, this->sums);
            pack_cluster_points(staging, points, this->order, first, count, this->stride, weights);
            this->commands.copy(staging, chunk.points, chunk.points.size());
            this->sync();
        }
    }

    void sync() {
        this->commands.end();
        const auto value = this->queue.submit(this->commands, this->fence);
        try {
            this->queue.wait_cpu(this->fence, value);
        } catch (...) {
            this->queue.wait_cpu();
            throw;
        }
        this->commands.reset();
        this->commands.begin();
    }

    void update_centers(Update mode, float alpha) {
        dispatch(
            this->commands, this->update, this->update_table, this->device.linear_groups(this->active, 128),
            std::array { this->active, static_cast<uint32_t>(this->stride), std::bit_cast<uint32_t>(alpha),
                static_cast<uint32_t>(mode) }
        );
    }

    void begin(const Centers& seeds) {
        if (this->active || seeds.cols() != static_cast<Eigen::Index>(this->columns) || seeds.rows() <= 0 ||
            static_cast<size_t>(seeds.rows()) > this->capacity) {
            throw std::invalid_argument("Invalid e-means seeds");
        }
        this->active = static_cast<uint32_t>(seeds.rows());
        auto* packed = reinterpret_cast<float*>(this->upload.mapped_data());
        for (size_t entry = 0; entry < this->active; ++entry) {
            std::copy_n(seeds.row(entry).data(), this->columns, packed);
            std::fill(packed + this->columns, packed + this->stride, 0.0f);
            packed += this->stride;
        }
        this->upload.flush();
        this->commands.copy(this->upload, this->centers, this->active * this->stride * sizeof(float));
        this->commands.fill(this->closing, 0, this->active * (this->stride + 1) * sizeof(float));
        this->update_centers(Initialize, 0);
    }

    void batch(size_t first, size_t count, float alpha, bool last) {
        if (!this->active || first >= this->order.size() || !count || count > this->order.size() ||
            !(alpha > 0 && alpha <= 1)) {
            throw std::invalid_argument("Invalid e-means batch");
        }
        this->commands.fill(this->sums, 0, this->active * (this->stride + 1) * sizeof(float));
        const auto groups_y = 1 + (this->active - 1) / this->device.limits().workgroup_count[0];
        const auto groups_x = 1 + (this->active - 1) / groups_y;
        const std::array reduce_groups { groups_x, groups_y, 1u };
        while (count) {
            auto& chunk = this->chunks[first / this->chunk_rows];
            const auto offset = static_cast<uint32_t>(first % this->chunk_rows);
            const auto length = static_cast<uint32_t>(std::min<size_t>(count, chunk.rows - offset));
            const auto global = static_cast<uint32_t>(first);
            dispatch_cluster(this->commands, this->assignment, chunk.assignment, length, this->active, offset, global);
            this->commands.fill(this->bins, 0, (2 * this->active + 1) * sizeof(uint32_t));
            const auto point_groups = this->device.linear_groups(length, 128);
            dispatch(this->commands, this->binning, this->bin_table, point_groups, std::array { length, global, 0u });
            dispatch(
                this->commands, this->offsets, this->offset_table, this->device.linear_groups(this->active, 128),
                std::array { this->active }
            );
            dispatch(this->commands, this->binning, this->bin_table, point_groups, std::array { length, global, 1u });
            dispatch(
                this->commands, this->reduce, chunk.reduce, reduce_groups,
                std::array { this->active, static_cast<uint32_t>(this->stride), offset,
                    static_cast<uint32_t>(chunk.rows * this->stride), groups_x }
            );
            first += length;
            if (first == this->order.size()) {
                first = 0;
            }
            count -= length;
        }
        this->update_centers(last ? LastEpoch : Train, alpha);
    }

    void read_usage(std::span<float> usage) {
        if (!this->active || usage.size() != this->active) {
            throw std::invalid_argument("Invalid e-means usage size");
        }
        this->commands.copy(this->state, this->readback, usage.size_bytes(), usage.size_bytes());
        this->sync();
        this->readback.read_into(std::as_writable_bytes(usage));
    }

    void split(std::span<const Split> splits) {
        if (splits.empty()) {
            return;
        }
        if (splits.size() > this->active / 2) {
            throw std::invalid_argument("Invalid e-means split count");
        }
        this->upload.upload(std::as_bytes(splits));
        this->commands.copy(this->upload, this->pairs, splits.size_bytes());
        const auto count = static_cast<uint32_t>(splits.size());
        dispatch(
            this->commands, this->splitting, this->split_table, this->device.linear_groups(count, 128),
            std::array { count, static_cast<uint32_t>(this->stride), this->active }
        );
    }

    Clustering finish() {
        if (!this->active) {
            throw std::logic_error("Missing e-means training pass");
        }
        this->update_centers(Finish, 0);
        std::vector<float> packed(this->active * this->stride);
        auto center_bytes = std::as_writable_bytes(std::span(packed));
        this->commands.copy(this->centers, this->readback, center_bytes.size());
        this->commands.copy(this->labels, this->readback, this->labels.size(), 0, center_bytes.size());
        this->sync();
        this->readback.read_into(center_bytes);
        std::vector<uint32_t> shuffled(this->order.size());
        this->readback.read_into(std::as_writable_bytes(std::span(shuffled)), center_bytes.size());
        Clustering result { Centers(this->active, this->columns), std::vector<uint32_t>(this->order.size()) };
        for (size_t entry = 0; entry < this->active; ++entry) {
            std::copy_n(packed.data() + entry * this->stride, this->columns, result.centroids.row(entry).data());
        }
        for (size_t row = 0; row < this->order.size(); ++row) {
            result.labels[this->order[row]] = shuffled[row];
        }
        this->active = 0;
        return result;
    }
};

EmeansGpu::EmeansGpu(
    FeatureView points, std::span<const float> weights, std::span<const uint32_t> order, size_t capacity,
    size_t chunk_rows
)
    : impl_(std::make_unique<Impl>(points, weights, order, capacity, chunk_rows)) {}
EmeansGpu::~EmeansGpu() = default;
void EmeansGpu::begin(const Centers& seeds) { this->impl_->begin(seeds); }
void EmeansGpu::batch(size_t first, size_t count, float alpha, bool closing) {
    this->impl_->batch(first, count, alpha, closing);
}
void EmeansGpu::revive(std::span<float> usage, SplitSelector choose) {
    this->impl_->read_usage(usage);
    this->impl_->split(choose(usage));
}
Clustering EmeansGpu::finish() { return this->impl_->finish(); }
} // namespace splat_transform::spatial
