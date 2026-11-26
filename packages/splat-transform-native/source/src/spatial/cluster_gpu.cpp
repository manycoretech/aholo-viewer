#include "cluster_gpu.h"
#include "cluster_schedule.h"
#include <algorithm>
#include <chrono>
#include <cluster.h>
#include <deque>
#include <gpu/compute.h>
#include <limits>
#include <utility/logger.h>

namespace splat_transform::spatial {
size_t cluster_tile(const gpu::ComputeDevice& device, size_t stride) {
    size_t tile = 128;
    while (tile * (stride + 1) * sizeof(float) > device.limits().shared_memory_bytes && tile > 1) {
        tile /= 2;
    }
    return tile;
}

gpu::ComputePipeline make_cluster_pipeline(const gpu::ComputeDevice& device, size_t stride, size_t tile) {
    const auto variant = std::ranges::find_if(shaders::cluster_variants, [&](const auto& shader) {
        return shader.columns == stride / 4 && shader.tile == tile;
    });
    if (variant == shaders::cluster_variants.end()) {
        throw std::runtime_error("Unsupported GPU clustering shader dimensions");
    }
    using enum gpu::BufferAccess;
    return device.create_pipeline({ std::string(variant->name), variant->code, { Read, Read, Read, ReadWrite }, 16 });
}

void dispatch_cluster(gpu::CommandList& commands, const gpu::ComputePipeline& pipeline, const gpu::DescriptorTable& table,
    uint32_t count, uint32_t active, uint32_t point_offset, uint32_t label_offset) {
    const std::array parameters { count, active, point_offset, label_offset };
    commands.bind_pipeline(pipeline);
    commands.bind_descriptor_table(table);
    commands.push_constants(std::as_bytes(std::span(parameters)));
    commands.dispatch({ (count + 127) / 128, 1, 1 });
}

void pack_cluster_points(const gpu::Buffer& upload, FeatureView points, std::span<const uint32_t> order, size_t start, size_t count, size_t stride, std::span<const float> weights) {
    auto* packed = reinterpret_cast<float*>(upload.mapped_data());
    for (size_t row = 0; row < count; ++row) {
        const auto source = order.empty() ? start + row : order[start + row];
        for (size_t column = 0; column < points.dimensions(); ++column) {
            packed[row * stride + column] = points(source, column);
        }
        std::fill(packed + row * stride + points.dimensions(), packed + (row + 1) * stride, 0.0f);
        if (!weights.empty()) {
            packed[count * stride + row] = weights[source];
        }
    }
    upload.flush();
}

struct ClusterSession::Impl {
    Impl(FeatureView points, size_t centroid_count, size_t max_batch_rows, std::span<const uint32_t> order)
        : points_(points), order_(order), columns_(points.dimensions()), rows_(points.rows()), centroid_count_(centroid_count), stride_((this->columns_ + 3) / 4 * 4) {
        if (!this->rows_ || !this->columns_ || !this->centroid_count_ || this->centroid_count_ > std::numeric_limits<uint32_t>::max()) {
            throw std::runtime_error("Invalid GPU clustering dimensions");
        }
        if (!order.empty() && (order.size() != this->rows_ || std::ranges::any_of(order, [&](auto row) { return row >= this->rows_; }))) {
            throw std::runtime_error("Invalid GPU clustering point order");
        }
        const size_t centroid_bytes = this->centroid_count_ * this->stride_ * sizeof(float);
        if (centroid_bytes > this->device_.limits().storage_buffer_bytes) {
            throw std::runtime_error("Clustering centroid table exceeds the storage buffer limit");
        }
        this->tile_ = cluster_tile(this->device_, this->stride_);
        this->pipeline_ = make_cluster_pipeline(this->device_, this->stride_, this->tile_);
        size_t budget = this->device_.available_memory();
        for (;;) {
            this->schedule_ = cluster_schedule(this->rows_, this->centroid_count_, this->stride_,
                { this->device_.limits().storage_buffer_bytes, this->device_.limits().workgroup_count[0], budget }, max_batch_rows);
            try {
                this->allocate();
                break;
            } catch (const gpu::AllocationFailure&) {
                this->clear();
                if (budget <= 32 * 1024 * 1024) {
                    throw;
                }
                budget = std::max<size_t>(32 * 1024 * 1024, budget / 2);
            }
        }
        this->upload_cached_points();
        this->tune_pending_ = this->rows_ >= 1024 * 1024 && this->centroid_count_ >= 32768 && this->tile_ >= 32 && !this->cached_.empty();
        const auto batches = (this->rows_ + this->schedule_.batch_rows - 1) / this->schedule_.batch_rows;
        const auto concurrency = std::min<size_t>(2, this->schedule_.cached_batches + this->schedule_.streaming_slots);
        utility::logger().info("GPU cluster assignment initialized with batch ", (this->schedule_.batch_rows + 127) / 128,
            "*128*", batches, ", concurrency: ", concurrency, ", runs: ", (batches + concurrency - 1) / concurrency);
    }
    ~Impl() {
        // The task owns all in-flight resources, including on exception paths.
        try {
            this->queue_.wait_cpu();
        } catch (...) {
        }
    }
    void assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
        std::span<uint32_t> labels, const std::function<void(size_t)>& ready, size_t first) try {
        if (static_cast<size_t>(centroids.cols()) != this->columns_) {
            throw std::runtime_error("GPU centroid column count differs");
        }
        const size_t active = static_cast<size_t>(centroids.rows());
        if (!active || active > this->centroid_count_) {
            throw std::runtime_error("GPU centroid count differs");
        }
        if (first > this->rows_ || labels.size() > this->rows_ - first) {
            throw std::runtime_error("GPU label count differs");
        }
        this->queue_.wait_cpu(this->fence_, this->centroid_value_);
        auto* packed = reinterpret_cast<float*>(this->centroid_upload_.mapped_data());
        auto* norms = reinterpret_cast<float*>(this->norm_upload_.mapped_data());
        for (size_t row = 0; row < active; ++row) {
            float norm = 0;
            for (size_t c = 0; c < this->columns_; ++c) {
                const auto value = centroids(row, c);
                packed[row * this->stride_ + c] = value;
                norm += static_cast<float>(value) * value;
            }
            std::fill(packed + row * this->stride_ + this->columns_, packed + (row + 1) * this->stride_, 0.0f);
            norms[row] = norm;
        }
        this->centroid_upload_.flush();
        this->norm_upload_.flush();
        if (active != this->recorded_centroids_) {
            this->record_centroids(active);
        }
        this->centroid_value_ = this->queue_.submit(this->centroid_command_, this->fence_);
        if (this->tune_pending_ && active == this->centroid_count_ && labels.size() == this->rows_) {
            this->tune();
        }
        std::deque<Slot*> pending;
        auto retire = [&] {
            auto* slot = pending.front();
            pending.pop_front();
            this->queue_.wait_cpu(this->fence_, slot->completion_value);
            const size_t output_offset = slot->start - first;
            slot->readback.read_into(std::as_writable_bytes(labels.subspan(output_offset, slot->count)));
            if (ready) {
                ready(output_offset + slot->count);
            }
        };
        const size_t end = first + labels.size();
        for (size_t start = first; start < end;) {
            const size_t batch = start / this->schedule_.batch_rows;
            const size_t offset = start % this->schedule_.batch_rows;
            const size_t count = std::min(end - start, this->schedule_.batch_rows - offset);
            // Two submissions keep transfer/CPU packing ahead without unbounded queueing.
            if (pending.size() == 2) {
                retire();
            }
            Slot* slot;
            if (batch < this->cached_.size()) {
                slot = this->cached_[batch].get();
                if (slot->start != start || slot->count != count || slot->active != active) {
                    this->record(*slot, start, count, offset, active, false);
                }
            } else {
                slot = this->streaming_[(batch - this->cached_.size()) % this->streaming_.size()].get();
                if (!pending.empty() && pending.front() == slot) {
                    retire();
                }
                pack_cluster_points(slot->upload, this->points_, this->order_, start, count, this->stride_);
                this->record(*slot, start, count, 0, active, true);
            }
            slot->completion_value = this->queue_.submit(slot->command, this->fence_);
            pending.push_back(slot);
            start += count;
        }
        while (!pending.empty()) {
            retire();
        }
    } catch (...) {
        // Finish borrowed resources before propagating a task failure or retry.
        try {
            this->queue_.wait_cpu();
        } catch (...) {
        }
        throw;
    }

    size_t rows() const { return this->rows_; }

private:
    struct Slot {
        gpu::Buffer points, labels, upload, readback;
        gpu::DescriptorTable table;
        gpu::CommandList command;
        uint64_t completion_value = 0;
        size_t start = 0;
        size_t count = 0;
        size_t active = 0;
    };
    void tune() {
        // Large jobs amortize a bounded sample of existing shader variants.
        // Shared-memory capacity alone does not predict kernel throughput.
        // Use resident points and the first real centroids; discard sample labels.
        std::array<gpu::ComputePipeline, 2> alternatives { make_cluster_pipeline(this->device_, this->stride_, this->tile_ / 2), make_cluster_pipeline(this->device_, this->stride_, this->tile_ / 4) };
        std::array<double, 3> durations;
        durations.fill(std::numeric_limits<double>::infinity());
        auto commands = this->device_.create_commands();
        const uint32_t count = static_cast<uint32_t>(std::min({ this->schedule_.batch_rows, this->rows_ / 32, static_cast<size_t>(131072) }));
        for (size_t pass = 0; pass < 3; ++pass) {
            for (size_t i = 0; i < durations.size(); ++i) {
                const size_t option = pass % 2 ? durations.size() - i - 1 : i;
                commands.reset();
                commands.begin();
                dispatch_cluster(commands, option ? alternatives[option - 1] : this->pipeline_, this->cached_.front()->table, count, static_cast<uint32_t>(this->centroid_count_));
                commands.end();
                const auto start = std::chrono::steady_clock::now();
                try {
                    const auto value = this->queue_.submit(commands, this->fence_);
                    this->queue_.wait_cpu(this->fence_, value);
                } catch (...) {
                    // Retire borrowed commands/pipelines before local owners unwind.
                    try {
                        this->queue_.wait_cpu();
                    } catch (...) {
                    }
                    throw;
                }
                const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
                if (pass) {
                    durations[option] = std::min(durations[option], elapsed);
                }
            }
        }
        commands.reset();
        const size_t best = static_cast<size_t>(std::min_element(durations.begin(), durations.end()) - durations.begin());
        // Retain the original choice when the difference is within timing noise.
        if (best && durations[best] < durations[0] * 0.95) {
            for (auto& slot : this->cached_) {
                slot->command.reset();
                slot->active = 0;
            }
            this->pipeline_ = std::move(alternatives[best - 1]);
            this->tile_ >>= best;
        }
        this->tune_pending_ = false;
        utility::logger().info("GPU cluster assignment tile selected: ", this->tile_, " (sample rows=", count,
            ", variant ms=", utility::fixed(static_cast<float>(durations[0] * 1000), 3), '/',
            utility::fixed(static_cast<float>(durations[1] * 1000), 3), '/', utility::fixed(static_cast<float>(durations[2] * 1000), 3), ')');
    }
    gpu::Buffer buffer(size_t bytes, gpu::BufferMemory memory = gpu::BufferMemory::Device) {
        return this->device_.create_buffer(bytes, memory, memory == gpu::BufferMemory::Device);
    }
    void allocate() {
        using enum gpu::BufferMemory;
        this->centroids_ = this->buffer(this->centroid_count_ * this->stride_ * sizeof(float));
        this->norms_ = this->buffer(this->centroid_count_ * sizeof(float));
        this->centroid_upload_ = this->buffer(this->centroids_.size(), Upload);
        this->norm_upload_ = this->buffer(this->norms_.size(), Upload);
        auto create_slot = [&](bool streaming) {
            auto slot = std::make_unique<Slot>();
            slot->points = this->buffer(this->schedule_.batch_rows * this->stride_ * sizeof(float));
            slot->labels = this->buffer(this->schedule_.batch_rows * sizeof(uint32_t));
            slot->readback = this->buffer(slot->labels.size(), Readback);
            if (streaming) {
                slot->upload = this->buffer(slot->points.size(), Upload);
            }
            const std::array<gpu::BufferRange, 4> bindings { gpu::BufferRange { &slot->points }, { &this->centroids_ }, { &this->norms_ }, { &slot->labels } };
            slot->table = this->device_.create_descriptor_table(this->pipeline_, bindings);
            slot->command = this->device_.create_commands();
            return slot;
        };
        for (size_t i = 0; i < this->schedule_.cached_batches; ++i) {
            this->cached_.push_back(create_slot(false));
        }
        for (size_t i = 0; i < this->schedule_.streaming_slots; ++i) {
            this->streaming_.push_back(create_slot(true));
        }
        this->centroid_command_ = this->device_.create_commands();
        if (!this->cached_.empty()) {
            this->initial_upload_ = this->buffer(this->schedule_.batch_rows * this->stride_ * sizeof(float), Upload);
        }
    }
    void clear() {
        this->cached_.clear();
        this->streaming_.clear();
        this->centroid_command_ = {};
        this->centroids_ = {};
        this->norms_ = {};
        this->centroid_upload_ = {};
        this->norm_upload_ = {};
        this->initial_upload_ = {};
    }
    void upload_cached_points() {
        if (this->cached_.empty()) {
            return;
        }
        auto command = this->device_.create_commands();
        for (size_t batch = 0; batch < this->cached_.size(); ++batch) {
            const size_t count = std::min(this->schedule_.batch_rows, this->rows_ - batch * this->schedule_.batch_rows);
            pack_cluster_points(this->initial_upload_, this->points_, this->order_, batch * this->schedule_.batch_rows, count, this->stride_);
            command.reset();
            command.begin();
            command.copy(this->initial_upload_, this->cached_[batch]->points, count * this->stride_ * sizeof(float));
            command.end();
            const auto value = this->queue_.submit(command, this->fence_);
            try {
                this->queue_.wait_cpu(this->fence_, value);
            } catch (...) {
                // Constructor failure must finish the borrowed local recording.
                try {
                    this->queue_.wait_cpu();
                } catch (...) {
                }
                throw;
            }
        }
        this->initial_upload_ = {};
    }
    void record_centroids(size_t active) {
        this->centroid_command_.reset();
        this->centroid_command_.begin();
        this->centroid_command_.copy(this->centroid_upload_, this->centroids_, active * this->stride_ * sizeof(float));
        this->centroid_command_.copy(this->norm_upload_, this->norms_, active * sizeof(float));
        this->centroid_command_.end();
        this->recorded_centroids_ = active;
    }
    void record(Slot& slot, size_t start, size_t count, size_t offset, size_t active, bool upload) {
        slot.start = start;
        slot.count = count;
        slot.active = active;
        slot.command.reset();
        slot.command.begin();
        if (upload) {
            slot.command.copy(slot.upload, slot.points, slot.count * this->stride_ * sizeof(float));
        }
        dispatch_cluster(slot.command, this->pipeline_, slot.table, static_cast<uint32_t>(count), static_cast<uint32_t>(active), static_cast<uint32_t>(offset));
        slot.command.copy(slot.labels, slot.readback, slot.count * sizeof(uint32_t));
        slot.command.end();
    }
    gpu::ComputeDevice device_;
    gpu::Queue& queue_ { this->device_.default_queue() };
    gpu::Fence fence_ { this->device_.create_fence() };
    uint64_t centroid_value_ = 0;
    FeatureView points_;
    std::span<const uint32_t> order_;
    size_t recorded_centroids_ = 0;
    size_t columns_, rows_, centroid_count_, stride_;
    size_t tile_ = 128;
    bool tune_pending_ = false;
    ClusterSchedule schedule_ {};
    gpu::ComputePipeline pipeline_;
    gpu::Buffer centroids_, norms_, centroid_upload_, norm_upload_, initial_upload_;
    std::vector<std::unique_ptr<Slot>> cached_, streaming_;
    gpu::CommandList centroid_command_;
};
ClusterSession::ClusterSession(FeatureView points, size_t centroid_count, size_t max_batch_rows, std::span<const uint32_t> order)
    : impl_(std::make_unique<Impl>(points, centroid_count, max_batch_rows, order)) {}
ClusterSession::~ClusterSession() = default;
std::vector<uint32_t> ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids) {
    std::vector<uint32_t> labels(this->impl_->rows());
    this->assign(centroids, labels);
    return labels;
}
void ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
    std::span<uint32_t> labels, const std::function<void(size_t)>& ready, size_t first) {
    this->impl_->assign(centroids, labels, ready, first);
}
} // namespace splat_transform::spatial
