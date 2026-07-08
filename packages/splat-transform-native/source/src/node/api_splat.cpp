#include <algorithm>
#include <atomic>
#include <cassert>
#include <container_helpers.h>
#include <future_helpers.h>
#include <node/api_buffer.h>
#include <node/api_splat.h>
#include <node/api_thread_pool.h>
#include <numeric>
#include <ranges>
#include <span>
#include <splat/splat.h>
#include <splat/splat_block.h>
#include <splat/splat_lod.h>
#include <thread_pool.h>

namespace {
enum SplatTable {
    SPLAT_TABLE_MEAN_X = 0,
    SPLAT_TABLE_MEAN_Y = 1,
    SPLAT_TABLE_MEAN_Z = 2,
    SPLAT_TABLE_SCALE_X = 3,
    SPLAT_TABLE_SCALE_Y = 4,
    SPLAT_TABLE_SCALE_Z = 5,
    SPLAT_TABLE_QUAT_X = 6,
    SPLAT_TABLE_QUAT_Y = 7,
    SPLAT_TABLE_QUAT_Z = 8,
    SPLAT_TABLE_QUAT_W = 9,
    SPLAT_TABLE_COLOR_R = 10,
    SPLAT_TABLE_COLOR_G = 11,
    SPLAT_TABLE_COLOR_B = 12,
    SPLAT_TABLE_OPACITY = 13,
    SPLAT_TABLE_SH_OFFSET = 14
};

inline splat::Splat read_splat(const std::vector<std::span<float>>& buffers, size_t sh_size, threading::ThreadPool& pool) {
    auto thread_count = pool.thread_count();
    auto read_count = std::atomic<size_t>(0);
    auto gaussian_count = buffers[0].size();
    auto gaussians = std::vector<splat::Gaussian>(gaussian_count);

    auto gaussian_per_thread = std::max(gaussian_count / thread_count, static_cast<size_t>(1));
    auto futures = std::vector<std::future<void>>();
    auto used_threads = std::min(gaussian_count, thread_count);

    futures.reserve(used_threads);
    read_count.store(0, std::memory_order_release);

    auto process_gaussian = [&, buffers](size_t start, size_t count) {
        for (auto i = 0; i < count; i++) {
            auto index = start + i;

            auto& gaussian = gaussians[index];
            gaussian.mean = Eigen::Vector3f(
                buffers[SPLAT_TABLE_MEAN_X][index],
                buffers[SPLAT_TABLE_MEAN_Y][index],
                buffers[SPLAT_TABLE_MEAN_Z][index]);
            gaussian.scale = Eigen::Vector3f(
                buffers[SPLAT_TABLE_SCALE_X][index],
                buffers[SPLAT_TABLE_SCALE_Y][index],
                buffers[SPLAT_TABLE_SCALE_Z][index]);
            gaussian.rotation = Eigen::Vector4f(
                buffers[SPLAT_TABLE_QUAT_X][index],
                buffers[SPLAT_TABLE_QUAT_Y][index],
                buffers[SPLAT_TABLE_QUAT_Z][index],
                buffers[SPLAT_TABLE_QUAT_W][index]);
            gaussian.opacity = buffers[SPLAT_TABLE_OPACITY][index];

            // SH
            gaussian.sh = ::splat::SH(sh_size + 3);
            gaussian.sh[0] = buffers[SPLAT_TABLE_COLOR_R][index];
            gaussian.sh[1] = buffers[SPLAT_TABLE_COLOR_G][index];
            gaussian.sh[2] = buffers[SPLAT_TABLE_COLOR_B][index];
            for (auto j = 3; j < gaussian.sh.size(); j++) {
                gaussian.sh[j] = buffers[SPLAT_TABLE_SH_OFFSET + j - 3][index];
            }

            gaussian.rotation.normalize();
            gaussian.compute_covariance();
            gaussian.compute_bounding_box();
        }
        read_count.fetch_add(count, std::memory_order_acq_rel);
    };

    for (auto i = 0; i < used_threads; i++) {
        futures.push_back(pool.submit_task(process_gaussian, gaussian_per_thread * i, gaussian_per_thread));
    }

    process_gaussian(gaussian_per_thread * used_threads, gaussian_count - gaussian_per_thread * used_threads);

    helpers::future::drain_futures(futures);

    assert(read_count.load(std::memory_order_acquire) == gaussian_count);

    auto splat = splat::Splat {
        .gaussians = std::move(gaussians),
        .bounding_box = Eigen::AlignedBox3f {},
    };
    splat.compute_bounding_box();
    return splat;
}

inline std::vector<Napi::Float32Array> write_splat(
    Napi::Env& env,
    size_t buffer_count,
    const splat::Splat& splat,
    threading::ThreadPool& pool) {
    auto buffers = std::vector<Napi::Float32Array>();
    auto buffer_spans = std::vector<std::span<float>>();
    auto thread_count = pool.thread_count();
    auto written_count = std::atomic<size_t>(0);
    buffers.reserve(buffer_count);
    buffer_spans.reserve(buffer_count);

    for (auto i = 0; i < buffer_count; i++) {
        buffers.push_back(Napi::Float32Array::New(env, splat.gaussians.size()));
        buffer_spans.emplace_back(buffers.back().Data(), splat.gaussians.size());
    }

    auto gaussian_per_thread = std::max(splat.gaussians.size() / thread_count, static_cast<size_t>(1));
    auto futures = std::vector<std::future<void>>();
    auto used_threads = std::min(splat.gaussians.size(), thread_count);

    futures.reserve(used_threads);
    written_count.store(0, std::memory_order_release);

    // transform gaussian to js readable struct
    auto process_gaussian = [&](size_t start, size_t count) {
        for (auto i = 0; i < count; i++) {
            auto index = start + i;
            auto write_index = index;
            auto& gaussian = splat.gaussians[index];

            buffer_spans[SPLAT_TABLE_MEAN_X][write_index] = gaussian.mean.x();
            buffer_spans[SPLAT_TABLE_MEAN_Y][write_index] = gaussian.mean.y();
            buffer_spans[SPLAT_TABLE_MEAN_Z][write_index] = gaussian.mean.z();
            buffer_spans[SPLAT_TABLE_SCALE_X][write_index] = gaussian.scale.x();
            buffer_spans[SPLAT_TABLE_SCALE_Y][write_index] = gaussian.scale.y();
            buffer_spans[SPLAT_TABLE_SCALE_Z][write_index] = gaussian.scale.z();
            buffer_spans[SPLAT_TABLE_QUAT_X][write_index] = gaussian.rotation.x();
            buffer_spans[SPLAT_TABLE_QUAT_Y][write_index] = gaussian.rotation.y();
            buffer_spans[SPLAT_TABLE_QUAT_Z][write_index] = gaussian.rotation.z();
            buffer_spans[SPLAT_TABLE_QUAT_W][write_index] = gaussian.rotation.w();
            buffer_spans[SPLAT_TABLE_COLOR_R][write_index] = gaussian.sh[0];
            buffer_spans[SPLAT_TABLE_COLOR_G][write_index] = gaussian.sh[1];
            buffer_spans[SPLAT_TABLE_COLOR_B][write_index] = gaussian.sh[2];
            buffer_spans[SPLAT_TABLE_OPACITY][write_index] = gaussian.opacity;

            for (auto j = 3; j < gaussian.sh.size(); j++) {
                buffer_spans[SPLAT_TABLE_SH_OFFSET + j - 3][write_index] = gaussian.sh[j];
            }
        }

        written_count.fetch_add(count, std::memory_order_acq_rel);
    };

    for (auto i = 0; i < used_threads; i++) {
        futures.push_back(pool.submit_task(process_gaussian, gaussian_per_thread * i, gaussian_per_thread));
    }

    process_gaussian(gaussian_per_thread * used_threads, splat.gaussians.size() - gaussian_per_thread * used_threads);

    helpers::future::drain_futures(futures);

    assert(written_count.load(std::memory_order_acquire) == splat.gaussians.size());

    return buffers;
}
} // namespace
namespace node_api::splat {
Napi::Value generate_lod(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 7 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsBuffer() || !info[3].IsNumber() || !info[4].IsNumber() || !info[5].IsNumber() || !info[6].IsObject()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto& pool = node_api::threading::ThreadPool::Unwrap(info[6].As<Napi::Object>())->impl();
    size_t thread_count = pool.thread_count();

    auto sh_size = info[1].As<Napi::Number>().Uint32Value();
    std::vector<::splat::Splat> blocks;
    // read & create blocks.
    {
        auto buffers = std::vector<std::span<float>>();
        auto array = info[0].As<Napi::Array>();
        buffers.reserve(sh_size + SPLAT_TABLE_SH_OFFSET);
        for (auto i = 0; i < sh_size + SPLAT_TABLE_SH_OFFSET; i++) {
            auto buffer = array[i].AsValue().As<Napi::Buffer<float>>();
            buffers.emplace_back(buffer.Data(), buffer.Length());
        }
        blocks = ::splat::block::split(
            read_splat(buffers, sh_size, pool),
            info[3].As<Napi::Number>().DoubleValue());
    }

    auto level_parameters = info[2].As<Napi::Buffer<::splat::lod::SplatLevelParameters>>();
    auto levels = level_parameters.Length();
    auto level_parameters_span = std::span(level_parameters.Data() + 1, level_parameters.Length() - 1);

    auto results = std::vector<::splat::Splat>();
    auto gaussian_count = std::make_unique<std::vector<uint32_t>>();
    auto block_boxes = std::make_unique<std::vector<float>>();
    auto block_refs = std::make_unique<std::vector<uint32_t>>();

    // reverse data, small.
    results.reserve(blocks.size() * levels);
    gaussian_count->reserve(blocks.size() * levels);
    block_boxes->reserve(blocks.size() * 6);
    block_refs->reserve(blocks.size() * levels);

    {
        auto futures = std::vector<std::future<::splat::lod::SplatLod>>();
        auto used_threads = std::min(blocks.size(), thread_count);
        auto min_size = info[4].As<Napi::Number>().Uint32Value();
        auto max_step = info[5].As<Napi::Number>().Uint32Value();

        futures.reserve(blocks.size());

        auto process_block = [&, levels, max_step](size_t index) -> ::splat::lod::SplatLod {
            auto& block = blocks[index];
            auto lod = ::splat::lod::SplatLod();
            lod.levels.reserve(levels);
            lod.splats.reserve(levels);
            lod.levels.push_back(0);
            lod.splats.push_back(std::move(block));
            if (level_parameters_span.size() > 0) {
                ::splat::lod::generate_lod(index, lod, level_parameters_span, min_size, max_step);
            }
            return lod;
        };

        for (auto i = 0; i < blocks.size(); i++) {
            futures.push_back(pool.submit_task(process_block, i));
        }

        helpers::future::drain_futures(futures, [&](::splat::lod::SplatLod block) {
            auto base_offset = static_cast<uint32_t>(results.size());
            {
                auto& bbx = block.splats.front().bounding_box;
                helpers::container::append_range(*block_boxes, bbx.min());
                helpers::container::append_range(*block_boxes, bbx.max());
            }
            helpers::container::append_range(*gaussian_count, block.splats | std::views::transform([](::splat::Splat& splat) -> uint32_t {
                return static_cast<uint32_t>(splat.gaussians.size());
            }));
            helpers::container::append_range(*block_refs, block.levels | std::views::transform([base_offset](uint32_t ref) -> uint32_t {
                return ref + base_offset;
            }));
            for (auto& splat : block.splats) {
                results.push_back(std::move(splat));
            }
        });

        // release blocks
        {
            auto _ = std::move(blocks);
        }
    }

    // auto total = std::reduce(gaussian_count->begin(), gaussian_count->end());
    auto buffers_per_splat = sh_size + SPLAT_TABLE_SH_OFFSET;
    auto buffers = std::vector<Napi::Float32Array>();

    buffers.reserve(buffers_per_splat * results.size());

    for (auto& splat : results) {
        helpers::container::append_range(buffers, write_splat(env, buffers_per_splat, splat, pool));

        // free data already transformed.
        {
            auto _ = std::move(splat);
        }
    }

    auto object = Napi::Object::New(env);
    {
        auto data = Napi::Array::New(env, buffers.size());
        auto offset = 0;
        object.Set("data", data);
        for (auto i = 0; i < buffers.size(); i++) {
            data[i] = buffers[i];
        }
        auto _ = std::move(buffers);
    }
    object.Set("blockBoxes", node_api::buffer::UniqueVecBufferFinalizer<float>::make_buffer(env, std::move(block_boxes)));
    object.Set("blockRefs", node_api::buffer::UniqueVecBufferFinalizer<uint32_t>::make_buffer(env, std::move(block_refs)));
    object.Set("gaussianCount", node_api::buffer::UniqueVecBufferFinalizer<uint32_t>::make_buffer(env, std::move(gaussian_count)));
    return object;
}

Napi::Value split(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsObject()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto& pool = node_api::threading::ThreadPool::Unwrap(info[3].As<Napi::Object>())->impl();
    size_t thread_count = pool.thread_count();

    auto sh_size = info[1].As<Napi::Number>().Uint32Value();
    std::vector<::splat::Splat> blocks;
    // read & create blocks.
    {
        auto buffers = std::vector<std::span<float>>();
        auto array = info[0].As<Napi::Array>();
        buffers.reserve(sh_size + SPLAT_TABLE_SH_OFFSET);
        for (auto i = 0; i < sh_size + SPLAT_TABLE_SH_OFFSET; i++) {
            auto buffer = array[i].AsValue().As<Napi::Buffer<float>>();
            buffers.emplace_back(buffer.Data(), buffer.Length());
        }
        blocks = ::splat::block::split(
            read_splat(buffers, sh_size, pool),
            info[2].As<Napi::Number>().DoubleValue());
    }

    auto buffers_per_splat = sh_size + SPLAT_TABLE_SH_OFFSET;
    auto block_boxes = std::make_unique<std::vector<float>>();
    auto gaussian_count = std::make_unique<std::vector<uint32_t>>();
    auto buffers = std::vector<Napi::Float32Array>();

    block_boxes->reserve(blocks.size() * 6);
    gaussian_count->reserve(blocks.size());
    buffers.reserve(buffers_per_splat * blocks.size());

    for (auto& splat : blocks) {

        helpers::container::append_range(buffers, write_splat(env, buffers_per_splat, splat, pool));
        gaussian_count->push_back(static_cast<uint32_t>(splat.gaussians.size()));
        {
            auto& bbx = splat.bounding_box;
            helpers::container::append_range(*block_boxes, bbx.min());
            helpers::container::append_range(*block_boxes, bbx.max());
        }

        // free data already transformed.
        {
            auto _ = std::move(splat);
        }
    }

    auto object = Napi::Object::New(env);
    {
        auto data = Napi::Array::New(env, buffers.size());
        auto offset = 0;
        object.Set("data", data);
        for (auto i = 0; i < buffers.size(); i++) {
            data[i] = buffers[i];
        }
        auto _ = std::move(buffers);
    }
    object.Set("blockBoxes", node_api::buffer::UniqueVecBufferFinalizer<float>::make_buffer(env, std::move(block_boxes)));
    object.Set("gaussianCount", node_api::buffer::UniqueVecBufferFinalizer<uint32_t>::make_buffer(env, std::move(gaussian_count)));
    return object;
}
} // namespace node_api::splat
