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
        : points_(points), order_(order), columns_(points.dimensions()), rows_(points.rows()), centroid_count_(centroid_count), stride_((columns_ + 3) / 4 * 4) {
        if (!rows_ || !columns_ || !centroid_count_ || centroid_count_ > std::numeric_limits<uint32_t>::max()) {
            throw std::runtime_error("Invalid GPU clustering dimensions");
        }
        if (!order.empty() && (order.size() != rows_ || std::ranges::any_of(order, [&](auto row) { return row >= rows_; }))) {
            throw std::runtime_error("Invalid GPU clustering point order");
        }
        const size_t centroid_bytes = centroid_count_ * stride_ * sizeof(float);
        if (centroid_bytes > device_.limits().storage_buffer_bytes) {
            throw std::runtime_error("Clustering centroid table exceeds the storage buffer limit");
        }
        tile_ = cluster_tile(device_, stride_);
        pipeline_ = make_cluster_pipeline(device_, stride_, tile_);
        size_t budget = device_.available_memory();
        for (;;) {
            schedule_ = cluster_schedule(rows_, centroid_count_, stride_,
                { device_.limits().storage_buffer_bytes, device_.limits().workgroup_count[0], budget }, max_batch_rows);
            try {
                allocate();
                break;
            } catch (const gpu::AllocationFailure&) {
                clear();
                if (budget <= 32 * 1024 * 1024) {
                    throw;
                }
                budget = std::max<size_t>(32 * 1024 * 1024, budget / 2);
            }
        }
        upload_cached_points();
        tune_pending_ = rows_ >= 1024 * 1024 && centroid_count_ >= 32768 && tile_ >= 32 && !cached_.empty();
        const auto batches = (rows_ + schedule_.batch_rows - 1) / schedule_.batch_rows;
        const auto concurrency = std::min<size_t>(2, schedule_.cached_batches + schedule_.streaming_slots);
        utility::logger().info("GPU cluster assignment initialized with batch ", (schedule_.batch_rows + 127) / 128,
            "*128*", batches, ", concurrency: ", concurrency, ", runs: ", (batches + concurrency - 1) / concurrency);
    }
    ~Impl() {
        // The task owns all in-flight resources, including on exception paths.
        try {
            queue_.wait_cpu();
        } catch (...) {
        }
    }
    void assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
        std::span<uint32_t> labels, const std::function<void(size_t)>& ready, size_t first) try {
        if (static_cast<size_t>(centroids.cols()) != columns_) {
            throw std::runtime_error("GPU centroid column count differs");
        }
        const size_t active = static_cast<size_t>(centroids.rows());
        if (!active || active > centroid_count_) {
            throw std::runtime_error("GPU centroid count differs");
        }
        if (first > rows_ || labels.size() > rows_ - first) {
            throw std::runtime_error("GPU label count differs");
        }
        queue_.wait_cpu(fence_, centroid_value_);
        auto* packed = reinterpret_cast<float*>(centroid_upload_.mapped_data());
        auto* norms = reinterpret_cast<float*>(norm_upload_.mapped_data());
        for (size_t row = 0; row < active; ++row) {
            float norm = 0;
            for (size_t c = 0; c < columns_; ++c) {
                const auto value = centroids(row, c);
                packed[row * stride_ + c] = value;
                norm += static_cast<float>(value) * value;
            }
            std::fill(packed + row * stride_ + columns_, packed + (row + 1) * stride_, 0.0f);
            norms[row] = norm;
        }
        centroid_upload_.flush();
        norm_upload_.flush();
        if (active != recorded_centroids_) {
            record_centroids(active);
        }
        centroid_value_ = queue_.submit(centroid_command_, fence_);
        if (tune_pending_ && active == centroid_count_ && labels.size() == rows_) {
            tune();
        }
        std::deque<Slot*> pending;
        auto retire = [&] {
            auto* slot = pending.front();
            pending.pop_front();
            queue_.wait_cpu(fence_, slot->completion_value);
            const size_t output_offset = slot->start - first;
            slot->readback.read_into(std::as_writable_bytes(labels.subspan(output_offset, slot->count)));
            if (ready) {
                ready(output_offset + slot->count);
            }
        };
        const size_t end = first + labels.size();
        for (size_t start = first; start < end;) {
            const size_t batch = start / schedule_.batch_rows;
            const size_t offset = start % schedule_.batch_rows;
            const size_t count = std::min(end - start, schedule_.batch_rows - offset);
            // Two submissions keep transfer/CPU packing ahead without unbounded queueing.
            if (pending.size() == 2) {
                retire();
            }
            Slot* slot;
            if (batch < cached_.size()) {
                slot = cached_[batch].get();
                if (slot->start != start || slot->count != count || slot->active != active) {
                    record(*slot, start, count, offset, active, false);
                }
            } else {
                slot = streaming_[(batch - cached_.size()) % streaming_.size()].get();
                if (!pending.empty() && pending.front() == slot) {
                    retire();
                }
                pack_cluster_points(slot->upload, points_, order_, start, count, stride_);
                record(*slot, start, count, 0, active, true);
            }
            slot->completion_value = queue_.submit(slot->command, fence_);
            pending.push_back(slot);
            start += count;
        }
        while (!pending.empty()) {
            retire();
        }
    } catch (...) {
        // Finish borrowed resources before propagating a task failure or retry.
        try {
            queue_.wait_cpu();
        } catch (...) {
        }
        throw;
    }

    size_t rows() const { return rows_; }

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
        std::array<gpu::ComputePipeline, 2> alternatives { make_cluster_pipeline(device_, stride_, tile_ / 2), make_cluster_pipeline(device_, stride_, tile_ / 4) };
        std::array<double, 3> durations;
        durations.fill(std::numeric_limits<double>::infinity());
        auto commands = device_.create_commands();
        const uint32_t count = static_cast<uint32_t>(std::min({ schedule_.batch_rows, rows_ / 32, static_cast<size_t>(131072) }));
        for (size_t pass = 0; pass < 3; ++pass) {
            for (size_t i = 0; i < durations.size(); ++i) {
                const size_t option = pass % 2 ? durations.size() - i - 1 : i;
                commands.reset();
                commands.begin();
                dispatch_cluster(commands, option ? alternatives[option - 1] : pipeline_, cached_.front()->table, count, static_cast<uint32_t>(centroid_count_));
                commands.end();
                const auto start = std::chrono::steady_clock::now();
                try {
                    const auto value = queue_.submit(commands, fence_);
                    queue_.wait_cpu(fence_, value);
                } catch (...) {
                    // Retire borrowed commands/pipelines before local owners unwind.
                    try {
                        queue_.wait_cpu();
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
            for (auto& slot : cached_) {
                slot->command.reset();
                slot->active = 0;
            }
            pipeline_ = std::move(alternatives[best - 1]);
            tile_ >>= best;
        }
        tune_pending_ = false;
        utility::logger().info("GPU cluster assignment tile selected: ", tile_, " (sample rows=", count,
            ", variant ms=", utility::fixed(static_cast<float>(durations[0] * 1000), 3), '/',
            utility::fixed(static_cast<float>(durations[1] * 1000), 3), '/', utility::fixed(static_cast<float>(durations[2] * 1000), 3), ')');
    }
    gpu::Buffer buffer(size_t bytes, gpu::BufferMemory memory = gpu::BufferMemory::Device) {
        return device_.create_buffer(bytes, memory, memory == gpu::BufferMemory::Device);
    }
    void allocate() {
        using enum gpu::BufferMemory;
        centroids_ = buffer(centroid_count_ * stride_ * sizeof(float));
        norms_ = buffer(centroid_count_ * sizeof(float));
        centroid_upload_ = buffer(centroids_.size(), Upload);
        norm_upload_ = buffer(norms_.size(), Upload);
        auto create_slot = [&](bool streaming) {
            auto slot = std::make_unique<Slot>();
            slot->points = buffer(schedule_.batch_rows * stride_ * sizeof(float));
            slot->labels = buffer(schedule_.batch_rows * sizeof(uint32_t));
            slot->readback = buffer(slot->labels.size(), Readback);
            if (streaming) {
                slot->upload = buffer(slot->points.size(), Upload);
            }
            const std::array<gpu::BufferRange, 4> bindings { gpu::BufferRange { &slot->points }, { &centroids_ }, { &norms_ }, { &slot->labels } };
            slot->table = device_.create_descriptor_table(pipeline_, bindings);
            slot->command = device_.create_commands();
            return slot;
        };
        for (size_t i = 0; i < schedule_.cached_batches; ++i) {
            cached_.push_back(create_slot(false));
        }
        for (size_t i = 0; i < schedule_.streaming_slots; ++i) {
            streaming_.push_back(create_slot(true));
        }
        centroid_command_ = device_.create_commands();
        if (!cached_.empty()) {
            initial_upload_ = buffer(schedule_.batch_rows * stride_ * sizeof(float), Upload);
        }
    }
    void clear() {
        cached_.clear();
        streaming_.clear();
        centroid_command_ = {};
        centroids_ = {};
        norms_ = {};
        centroid_upload_ = {};
        norm_upload_ = {};
        initial_upload_ = {};
    }
    void upload_cached_points() {
        if (cached_.empty()) {
            return;
        }
        auto command = device_.create_commands();
        for (size_t batch = 0; batch < cached_.size(); ++batch) {
            const size_t count = std::min(schedule_.batch_rows, rows_ - batch * schedule_.batch_rows);
            pack_cluster_points(initial_upload_, points_, order_, batch * schedule_.batch_rows, count, stride_);
            command.reset();
            command.begin();
            command.copy(initial_upload_, cached_[batch]->points, count * stride_ * sizeof(float));
            command.end();
            const auto value = queue_.submit(command, fence_);
            try {
                queue_.wait_cpu(fence_, value);
            } catch (...) {
                // Constructor failure must finish the borrowed local recording.
                try {
                    queue_.wait_cpu();
                } catch (...) {
                }
                throw;
            }
        }
        initial_upload_ = {};
    }
    void record_centroids(size_t active) {
        centroid_command_.reset();
        centroid_command_.begin();
        centroid_command_.copy(centroid_upload_, centroids_, active * stride_ * sizeof(float));
        centroid_command_.copy(norm_upload_, norms_, active * sizeof(float));
        centroid_command_.end();
        recorded_centroids_ = active;
    }
    void record(Slot& slot, size_t start, size_t count, size_t offset, size_t active, bool upload) {
        slot.start = start;
        slot.count = count;
        slot.active = active;
        slot.command.reset();
        slot.command.begin();
        if (upload) {
            slot.command.copy(slot.upload, slot.points, slot.count * stride_ * sizeof(float));
        }
        dispatch_cluster(slot.command, pipeline_, slot.table, static_cast<uint32_t>(count), static_cast<uint32_t>(active), static_cast<uint32_t>(offset));
        slot.command.copy(slot.labels, slot.readback, slot.count * sizeof(uint32_t));
        slot.command.end();
    }
    gpu::ComputeDevice device_;
    gpu::Queue& queue_ { device_.default_queue() };
    gpu::Fence fence_ { device_.create_fence() };
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
    std::vector<uint32_t> labels(impl_->rows());
    assign(centroids, labels);
    return labels;
}
void ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
    std::span<uint32_t> labels, const std::function<void(size_t)>& ready, size_t first) {
    impl_->assign(centroids, labels, ready, first);
}
} // namespace splat_transform::spatial
