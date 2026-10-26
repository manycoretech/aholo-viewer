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
struct ClusterSession::Impl {
    Impl(FeatureView points, size_t centroid_count, size_t max_batch_rows)
        : points_(points), columns_(points.dimensions()), rows_(points.rows()), centroid_count_(centroid_count), stride_((columns_ + 3) / 4 * 4) {
        if (!rows_ || !columns_ || !centroid_count_ || centroid_count_ > UINT32_MAX) {
            throw std::runtime_error("Invalid GPU clustering dimensions");
        }
        const size_t centroid_bytes = centroid_count_ * stride_ * sizeof(float);
        if (centroid_bytes > device_.limits().storage_buffer_bytes) {
            throw std::runtime_error("Clustering centroid table exceeds the storage buffer limit");
        }
        while (tile_ * (stride_ * sizeof(float) + sizeof(float)) > device_.limits().shared_memory_bytes && tile_ > 1) {
            tile_ /= 2;
        }
        pipeline_ = create_pipeline(tile_);
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
        record_centroids();
        for (size_t i = 0; i < cached_.size(); ++i) {
            record(*cached_[i], i * schedule_.batch_rows, false);
        }
        tune_pending_ = rows_ >= 1024 * 1024 && centroid_count_ >= 32768 && tile_ >= 32 && !cached_.empty();
        const auto batches = (rows_ + schedule_.batch_rows - 1) / schedule_.batch_rows;
        const auto concurrency = std::min<size_t>(2, schedule_.cached_batches + schedule_.streaming_slots);
        utility::logger().info("GPU k-means kernel bootstrapped with batch ", (schedule_.batch_rows + 127) / 128,
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
        std::span<uint32_t> labels, const std::function<void(size_t)>& ready) try {
        if (static_cast<size_t>(centroids.cols()) != columns_) {
            throw std::runtime_error("GPU centroid column count differs");
        }
        if (static_cast<size_t>(centroids.rows()) != centroid_count_) {
            throw std::runtime_error("GPU centroid count differs");
        }
        if (labels.size() != rows_) {
            throw std::runtime_error("GPU label count differs");
        }
        queue_.wait_cpu(fence_, centroid_value_);
        auto* packed = reinterpret_cast<float*>(centroid_upload_.mapped_data());
        auto* norms = reinterpret_cast<float*>(norm_upload_.mapped_data());
        for (size_t row = 0; row < centroid_count_; ++row) {
            float norm = 0;
            for (size_t c = 0; c < columns_; ++c) {
                const auto value = centroids(row, c);
                packed[row * stride_ + c] = value;
                norm += float(value) * value;
            }
            std::fill(packed + row * stride_ + columns_, packed + (row + 1) * stride_, 0.0f);
            norms[row] = norm;
        }
        centroid_upload_.flush();
        norm_upload_.flush();
        centroid_value_ = queue_.submit(centroid_command_, fence_);
        if (tune_pending_) {
            tune();
        }
        std::deque<Slot*> pending;
        auto retire = [&] {
            auto* slot = pending.front();
            pending.pop_front();
            queue_.wait_cpu(fence_, slot->completion_value);
            slot->readback.read_into(std::as_writable_bytes(labels.subspan(slot->start, slot->count)));
            if (ready) {
                ready(slot->start + slot->count);
            }
        };
        const size_t batches = (rows_ + schedule_.batch_rows - 1) / schedule_.batch_rows;
        for (size_t batch = 0; batch < batches; ++batch) {
            // Two submissions keep transfer/CPU packing ahead without unbounded queueing.
            if (pending.size() == 2) {
                retire();
            }
            Slot* slot;
            if (batch < cached_.size()) {
                slot = cached_[batch].get();
            } else {
                slot = streaming_[(batch - cached_.size()) % streaming_.size()].get();
                if (!pending.empty() && pending.front() == slot) {
                    retire();
                }
                pack_points(slot->upload, batch * schedule_.batch_rows);
                record(*slot, batch * schedule_.batch_rows, true);
            }
            slot->completion_value = queue_.submit(slot->command, fence_);
            pending.push_back(slot);
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
    };
    gpu::ComputePipeline create_pipeline(size_t tile) const {
        const auto variant = std::ranges::find_if(shaders::cluster_variants, [&](const auto& shader) {
            return shader.columns == stride_ / 4 && shader.tile == tile;
        });
        if (variant == shaders::cluster_variants.end()) {
            throw std::runtime_error("Unsupported GPU clustering shader dimensions");
        }
        using enum gpu::BufferAccess;
        return device_.create_pipeline({ std::string(variant->name), variant->code, { Read, Read, Read, ReadWrite }, 8 });
    }
    void tune() {
        // Large jobs amortize a bounded sample of existing shader variants.
        // Shared-memory capacity alone does not predict kernel throughput.
        // Use resident points and the first real centroids; discard sample labels.
        std::array<gpu::ComputePipeline, 2> alternatives { create_pipeline(tile_ / 2), create_pipeline(tile_ / 4) };
        std::array<double, 3> durations;
        durations.fill(std::numeric_limits<double>::infinity());
        auto commands = device_.create_commands();
        const uint32_t count = uint32_t(std::min({ schedule_.batch_rows, rows_ / 32, size_t(131072) }));
        const std::array<uint32_t, 2> parameters { count, uint32_t(centroid_count_) };
        for (size_t pass = 0; pass < 3; ++pass) {
            for (size_t i = 0; i < durations.size(); ++i) {
                const size_t option = pass % 2 ? durations.size() - i - 1 : i;
                commands.reset();
                commands.begin();
                commands.bind_pipeline(option ? alternatives[option - 1] : pipeline_);
                commands.bind_descriptor_table(cached_.front()->table);
                commands.push_constants(std::as_bytes(std::span(parameters)));
                commands.dispatch({ (count + 127) / 128, 1, 1 });
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
        const size_t best = size_t(std::min_element(durations.begin(), durations.end()) - durations.begin());
        // Retain the original choice when the difference is within timing noise.
        if (best && durations[best] < durations[0] * 0.95) {
            for (auto& slot : cached_) {
                slot->command.reset();
            }
            pipeline_ = std::move(alternatives[best - 1]);
            tile_ >>= best;
            for (size_t i = 0; i < cached_.size(); ++i) {
                record(*cached_[i], i * schedule_.batch_rows, false);
            }
        }
        tune_pending_ = false;
        utility::logger().info("GPU k-means tile selected: ", tile_, " (sample rows=", count,
            ", variant ms=", utility::fixed(float(durations[0] * 1000), 3), '/',
            utility::fixed(float(durations[1] * 1000), 3), '/', utility::fixed(float(durations[2] * 1000), 3), ')');
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
    void pack_points(const gpu::Buffer& upload, size_t start) {
        auto* packed = reinterpret_cast<float*>(upload.mapped_data());
        const auto count = std::min(schedule_.batch_rows, rows_ - start);
        for (size_t row = 0; row < count; ++row) {
            for (size_t c = 0; c < columns_; ++c) {
                packed[row * stride_ + c] = points_(start + row, c);
            }
            std::fill(packed + row * stride_ + columns_, packed + (row + 1) * stride_, 0.0f);
        }
        upload.flush();
    }
    void upload_cached_points() {
        if (cached_.empty()) {
            return;
        }
        auto command = device_.create_commands();
        for (size_t batch = 0; batch < cached_.size(); ++batch) {
            pack_points(initial_upload_, batch * schedule_.batch_rows);
            command.reset();
            command.begin();
            const size_t count = std::min(schedule_.batch_rows, rows_ - batch * schedule_.batch_rows);
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
    void record_centroids() {
        centroid_command_.begin();
        centroid_command_.copy(centroid_upload_, centroids_, centroids_.size());
        centroid_command_.copy(norm_upload_, norms_, norms_.size());
        centroid_command_.end();
    }
    void record(Slot& slot, size_t start, bool upload) {
        slot.start = start;
        slot.count = std::min(schedule_.batch_rows, rows_ - start);
        slot.command.reset();
        slot.command.begin();
        if (upload) {
            slot.command.copy(slot.upload, slot.points, slot.count * stride_ * sizeof(float));
        }
        const std::array<uint32_t, 2> parameters { uint32_t(slot.count), uint32_t(centroid_count_) };
        slot.command.bind_pipeline(pipeline_);
        slot.command.bind_descriptor_table(slot.table);
        slot.command.push_constants(std::as_bytes(std::span(parameters)));
        slot.command.dispatch({ uint32_t((slot.count + 127) / 128), 1, 1 });
        slot.command.copy(slot.labels, slot.readback, slot.count * sizeof(uint32_t));
        slot.command.end();
    }
    gpu::ComputeDevice device_;
    gpu::Queue& queue_ { device_.default_queue() };
    gpu::Fence fence_ { device_.create_fence() };
    uint64_t centroid_value_ = 0;
    FeatureView points_;
    size_t columns_, rows_, centroid_count_, stride_;
    size_t tile_ = 128;
    bool tune_pending_ = false;
    ClusterSchedule schedule_ {};
    gpu::ComputePipeline pipeline_;
    gpu::Buffer centroids_, norms_, centroid_upload_, norm_upload_, initial_upload_;
    std::vector<std::unique_ptr<Slot>> cached_, streaming_;
    gpu::CommandList centroid_command_;
};
ClusterSession::ClusterSession(FeatureView points, size_t centroid_count, size_t max_batch_rows) : impl_(std::make_unique<Impl>(points, centroid_count, max_batch_rows)) {}
ClusterSession::~ClusterSession() = default;
std::vector<uint32_t> ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids) {
    std::vector<uint32_t> labels(impl_->rows());
    impl_->assign(centroids, labels, {});
    return labels;
}
void ClusterSession::assign(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& centroids,
    std::span<uint32_t> labels, const std::function<void(size_t)>& ready) {
    impl_->assign(centroids, labels, ready);
}
} // namespace splat_transform::spatial
