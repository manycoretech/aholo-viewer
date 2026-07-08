#include <algorithm>
#include <cstdint>
#include <future>
#include <future_helpers.h>
#include <memory>
#include <node/api_spatial.h>
#include <node/api_thread_pool.h>
#include <random>
#include <span>
#include <thread>
#include <thread_pool.h>
#include <vector>

namespace {
struct PartialAverage {
    std::unique_ptr<float[]> sums;
    std::unique_ptr<size_t[]> counts;
};
} // namespace

namespace node_api::spatial {
Napi::Value cluster_average(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 5 || !info[0].IsArray() || !info[1].IsBuffer() || !info[2].IsNumber() || !info[3].IsArray() || !info[4].IsObject()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto input_table = info[0].As<Napi::Array>();
    auto input_labels = info[1].As<Napi::Buffer<uint32_t>>();
    auto cluster_count = static_cast<size_t>(info[2].As<Napi::Number>().Uint32Value());
    auto output_table = info[3].As<Napi::Array>();
    auto thread_pool_wrapper = node_api::threading::ThreadPool::Unwrap(info[4].As<Napi::Object>());

    auto col_size = input_table.Length();

    auto data_table = std::vector<std::span<float>>();
    auto output = std::vector<std::span<float>>();
    data_table.reserve(col_size);
    output.reserve(col_size);

    for (auto i = 0; i < col_size; i++) {
        auto data = input_table.Get(i).As<Napi::Buffer<float>>();
        auto out = output_table.Get(i).As<Napi::Buffer<float>>();
        data_table.emplace_back(data.Data(), data.Length());
        output.emplace_back(out.Data(), out.Length());
    }

    auto labels = std::span<uint32_t>(input_labels.Data(), input_labels.Length());
    auto row_size = data_table[0].size();

    auto& pool = thread_pool_wrapper->impl();
    auto partials = std::vector<PartialAverage>();
    auto fallback_rows = std::vector<size_t>(cluster_count, 0);
    if (row_size > 0) {
        std::random_device random_device;
        auto seed = (static_cast<uint64_t>(random_device()) << 32) ^ static_cast<uint64_t>(random_device());
        auto rng = std::mt19937_64(seed);
        auto row_distribution = std::uniform_int_distribution<size_t>(0, row_size - 1);
        for (auto& row_index : fallback_rows) {
            row_index = row_distribution(rng);
        }
    }

    auto process_rows = [&](size_t begin, size_t end) -> PartialAverage {
        auto partial = PartialAverage {
            .sums = std::make_unique<float[]>(cluster_count * col_size),
            .counts = std::make_unique<size_t[]>(cluster_count),
        };
        for (auto row_index = begin; row_index < end; row_index++) {
            auto cluster_index = labels[row_index];
            if (cluster_index >= cluster_count) {
                continue;
            }

            partial.counts[cluster_index]++;
            auto sum_offset = static_cast<size_t>(cluster_index) * col_size;
            for (auto column_index = 0; column_index < col_size; column_index++) {
                partial.sums[sum_offset + column_index] += data_table[column_index][row_index];
            }
        }
        return partial;
    };

    auto reduce_clusters = [&](size_t begin, size_t end) {
        for (auto cluster_index = begin; cluster_index < end; cluster_index++) {
            size_t count = 0;
            for (auto column_index = 0; column_index < col_size; column_index++) {
                output[column_index][cluster_index] = 0.0f;
            }

            auto sum_offset = cluster_index * col_size;
            for (auto& partial : partials) {
                count += partial.counts[cluster_index];
                for (auto column_index = 0; column_index < col_size; column_index++) {
                    output[column_index][cluster_index] += partial.sums[sum_offset + column_index];
                }
            }

            if (count == 0) {
                auto row_index = fallback_rows[cluster_index];
                for (auto column_index = 0; column_index < col_size; column_index++) {
                    output[column_index][cluster_index] = data_table[column_index][row_index];
                }
            } else {
                auto inv_count = 1.0f / static_cast<float>(count);
                for (auto column_index = 0; column_index < col_size; column_index++) {
                    output[column_index][cluster_index] *= inv_count;
                }
            }
        }
    };

    {
        size_t used_thread_count = std::min(pool.thread_count(), row_size);

        auto row_tasks = std::vector<std::future<PartialAverage>>();
        row_tasks.reserve(used_thread_count);

        auto rows_per_thread = (row_size + used_thread_count - 1) / used_thread_count;
        // process rows, calculate sum per thread.
        for (size_t thread_index = 0; thread_index < used_thread_count; thread_index++) {
            auto begin = thread_index * rows_per_thread;
            auto end = std::min(begin + rows_per_thread, row_size);
            row_tasks.push_back(pool.submit_task(process_rows, begin, end));
        }

        partials.reserve(row_tasks.size());
        helpers::future::drain_futures(row_tasks, [&](PartialAverage&& data) {
            partials.push_back(std::move(data));
        });
    }

    {
        size_t used_thread_count = std::min(pool.thread_count(), cluster_count);
        auto tasks = std::vector<std::future<void>>();
        tasks.reserve(used_thread_count);
        auto clusters_per_thread = (cluster_count + used_thread_count - 1) / used_thread_count;
        // reduce threaded cluster result
        for (size_t thread_index = 0; thread_index < used_thread_count; thread_index++) {
            auto begin = thread_index * clusters_per_thread;
            auto end = std::min(begin + clusters_per_thread, cluster_count);
            tasks.push_back(pool.submit_task(reduce_clusters, begin, end));
        }
        helpers::future::drain_futures(tasks);
    }

    return env.Null();
}
} // namespace node_api::spatial
