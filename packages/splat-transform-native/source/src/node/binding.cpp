#include <concepts>
#include <napi.h>
#include <node/api_avif.h>
#include <node/api_spatial.h>
#include <node/api_splat.h>
#include <node/api_thread_pool.h>
#include <node/api_webp.h>
#include <type_traits>
#include <utility>

namespace {
struct InstanceData {
    Napi::FunctionReference thread_pool;
};

template<typename F>
    requires requires(F f, const Napi::CallbackInfo& info) {
        { f(info) } -> std::same_as<Napi::Value>;
    }
auto wrap_call(F&& f) {
    return [f = std::forward<F>(f)](const Napi::CallbackInfo& info) {
        try {
            return f(info);
        } catch (const Napi::Error&) {
            throw;
        } catch (const std::exception& ex) {
            auto env = info.Env();
            Napi::Error::New(env, ex.what()).ThrowAsJavaScriptException();
            return env.Null();
        } catch (...) {
            auto env = info.Env();
            Napi::Error::New(env, "Unknown runtime exception").ThrowAsJavaScriptException();
            return env.Null();
        }
    };
}
} // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("generate_splat_lod", Napi::Function::New(env, wrap_call(node_api::splat::generate_lod)));
    exports.Set("split_splat", Napi::Function::New(env, wrap_call(node_api::splat::split)));
    exports.Set("webp_encode_rgba", Napi::Function::New(env, wrap_call(node_api::imaging::webp_encode_rgba)));
    exports.Set("webp_encode_rgba_lossless", Napi::Function::New(env, wrap_call(node_api::imaging::webp_encode_rgba_lossless)));
    exports.Set("webp_decode_rgba", Napi::Function::New(env, wrap_call(node_api::imaging::webp_decode_rgba)));
    exports.Set("avif_encode_rgba", Napi::Function::New(env, wrap_call(node_api::imaging::avif_encode_rgba)));
    exports.Set("avif_encode_rgba_batched", Napi::Function::New(env, wrap_call(node_api::imaging::avif_encode_rgba_batched)));
    exports.Set("avif_decode_rgba", Napi::Function::New(env, wrap_call(node_api::imaging::avif_decode_rgba)));
    exports.Set("avif_decode_rgba_batched", Napi::Function::New(env, wrap_call(node_api::imaging::avif_decode_rgba_batched)));
    exports.Set("cluster_average", Napi::Function::New(env, wrap_call(node_api::spatial::cluster_average)));
    auto instance_data = new InstanceData {
        .thread_pool = node_api::threading::ThreadPool::Init(env, exports)
    };
    env.SetInstanceData<InstanceData>(instance_data);
    return exports;
}

NODE_API_MODULE(addon_napi, Init)
