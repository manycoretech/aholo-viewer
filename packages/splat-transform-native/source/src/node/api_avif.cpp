#include <avif/avif_cxx.h>
#include <bit>
#include <future_helpers.h>
#include <memory>
#include <node/api_avif.h>
#include <node/api_buffer.h>
#include <node/api_thread_pool.h>
#include <span>
#include <thread>
#include <thread_pool.h>
#include <vector>

namespace {
class RawData {
public:
    RawData() noexcept : data_(AVIF_DATA_EMPTY) {}
    RawData(RawData&& other) noexcept : data_(other.data_) {
        other.data_ = AVIF_DATA_EMPTY;
    }
    RawData(avifRWData&& data) noexcept : data_(data) {
        data = AVIF_DATA_EMPTY;
    }
    RawData(const RawData& other) = delete;
    void operator()(Napi::Env env, uint8_t* data) noexcept {}

    RawData& operator=(RawData&& other) noexcept {
        this->data_ = other.data_;
        other.data_ = AVIF_DATA_EMPTY;
        return *this;
    }

    RawData& operator=(const RawData& other) = delete;

    avifRWData& data() {
        return this->data_;
    }

    const avifRWData& data() const {
        return this->data_;
    }

    Napi::Buffer<uint8_t> make_buffer(Napi::Env& env) {
        auto ptr = this->data_.data;
        auto size = this->data_.size;
        return Napi::Buffer<uint8_t>::NewOrCopy(env, ptr, size, std::move(*this));
    }

    ~RawData() {
        if (this->data_.data != nullptr) {
            avifRWDataFree(&this->data_);
        }
    }

private:
    avifRWData data_;
};

class RGBImageData {
public:
    RGBImageData() noexcept : data_({ 0 }) {}
    RGBImageData(RGBImageData&& other) noexcept : data_(other.data_) {
        other.data_ = { 0 };
    }
    RGBImageData(avifRGBImage&& data) noexcept : data_(data) {
        data = { 0 };
    }
    RGBImageData(const RawData& other) = delete;
    void operator()(Napi::Env env, uint8_t* data) noexcept {}

    RGBImageData& operator=(RGBImageData&& other) noexcept {
        this->data_ = other.data_;
        other.data_ = { 0 };
        return *this;
    }

    RGBImageData& operator=(const RGBImageData& other) = delete;

    avifRGBImage& data() {
        return this->data_;
    }

    const avifRGBImage& data() const {
        return this->data_;
    }

    Napi::Buffer<uint8_t> make_buffer(Napi::Env& env) {
        auto ptr = this->data_.pixels;
        auto size = this->data_.rowBytes * this->data_.height;
        return Napi::Buffer<uint8_t>::NewOrCopy(env, ptr, size, std::move(*this));
    }

    ~RGBImageData() {
        if (this->data_.pixels != nullptr) {
            avifRGBImageFreePixels(&this->data_);
        }
    }

private:
    avifRGBImage data_;
};

RawData avif_encode_rga_impl(std::span<uint8_t> pixels, int32_t width, int32_t height, int32_t quality, int32_t max_threads) {
    avif::EncoderPtr encoder = nullptr;
    avifRGBImage rgb;
    std::memset(&rgb, 0, sizeof(rgb));
    avif::ImagePtr image(avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV444));

    avifRGBImageSetDefaults(&rgb, image.get());
    rgb.pixels = pixels.data();
    rgb.rowBytes = 4 * rgb.width;
    avifResult convertResult = avifImageRGBToYUV(image.get(), &rgb);

    if (convertResult != AVIF_RESULT_OK) {
        throw std::runtime_error("Failed to convert to YUV(A)");
    }

    encoder.reset(avifEncoderCreate());
    if (encoder == nullptr) {
        throw std::runtime_error("Out of memory");
    }

    encoder->quality = quality;
    encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    encoder->maxThreads = max_threads;

    avifResult addImageResult = avifEncoderAddImage(encoder.get(), image.get(), 1, AVIF_ADD_IMAGE_FLAG_SINGLE);

    if (addImageResult != AVIF_RESULT_OK) {
        throw std::runtime_error("Failed to add image to encoder");
    }

    RawData avifOutput;
    avifResult finishResult = avifEncoderFinish(encoder.get(), &avifOutput.data());

    if (finishResult != AVIF_RESULT_OK) {
        throw std::runtime_error("Failed to finish encode");
    }

    return avifOutput;
}

RGBImageData avif_decode_rgba_impl(std::span<uint8_t> data, int32_t max_threads) {
    avif::DecoderPtr decoder(avifDecoderCreate());

    if (decoder == nullptr) {
        throw std::runtime_error("Out of memory");
    }

    decoder->maxThreads = max_threads;

    avifResult result = avifDecoderSetIOMemory(decoder.get(), data.data(), data.size());

    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error("Cannot set IO on avifDecoder");
    }

    result = avifDecoderParse(decoder.get());

    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error("Failed to decode image");
    }

    result = avifDecoderNextImage(decoder.get());

    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error("Failed to get image");
    }

    RGBImageData rgb;
    avifRGBImageSetDefaults(&rgb.data(), decoder->image);
    result = avifRGBImageAllocatePixels(&rgb.data());

    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error("Allocation of RGB samples failed");
    }

    result = avifImageYUVToRGB(decoder->image, &rgb.data());

    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error("Conversion from YUV failed");
    }

    return rgb;
}
} // namespace

namespace node_api::imaging {
Napi::Value avif_encode_rgba(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 4 || !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
    auto width = info[1].As<Napi::Number>().Int32Value();
    auto height = info[2].As<Napi::Number>().Int32Value();
    auto quality = info[3].As<Napi::Number>().Int32Value();

    return avif_encode_rga_impl(
        std::span(buffer.Data(), buffer.Length()),
        width, height,
        quality, static_cast<int32_t>(std::thread::hardware_concurrency()))
        .make_buffer(env);
}
Napi::Value avif_encode_rgba_batched(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    constexpr auto max_thread = 16;
    auto& pool = node_api::threading::ThreadPool::Unwrap(info[1].As<Napi::Object>())->impl();
    auto thread_count = pool.thread_count();
    auto inputs = info[0].As<Napi::Array>();
    auto input_count = inputs.Length();
    auto outputs = Napi::Array::New(env, input_count);

    {
        auto futures = std::vector<std::future<RawData>>();
        futures.reserve(inputs.Length());
        for (auto i = 0; i < input_count; i++) {
            auto input = inputs[i].AsValue().As<Napi::Object>();
            auto buffer = input.Get("data").As<Napi::Buffer<uint8_t>>();
            auto width = input.Get("width").As<Napi::Number>().Int32Value();
            auto height = input.Get("height").As<Napi::Number>().Int32Value();
            auto quality = input.Get("quality").As<Napi::Number>().Int32Value();
            futures.push_back(pool.submit_task(avif_encode_rga_impl, std::span(buffer.Data(), buffer.Length()), width, height, quality, max_thread));
        }

        helpers::future::drain_futures(futures, [&](RawData&& data, size_t i) {
            outputs[i] = data.make_buffer(env);
        });
    }

    return outputs;
}
Napi::Value avif_decode_rgba(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    auto buffer = info[0].As<Napi::Buffer<uint8_t>>();

    auto&& rgb = avif_decode_rgba_impl(std::span(buffer.Data(), buffer.Length()),
        static_cast<int32_t>(std::thread::hardware_concurrency()));

    auto object = Napi::Object::New(env);
    {
        object.Set("width", Napi::Number::New(env, rgb.data().width));
        object.Set("height", Napi::Number::New(env, rgb.data().height));
        object.Set("data", rgb.make_buffer(env));
    }
    return object;
}

Napi::Value avif_decode_rgba_batched(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Wrong Arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    constexpr auto max_thread = 16;
    auto& pool = node_api::threading::ThreadPool::Unwrap(info[1].As<Napi::Object>())->impl();
    auto thread_count = pool.thread_count();
    auto inputs = info[0].As<Napi::Array>();
    auto input_count = inputs.Length();
    auto outputs = Napi::Array::New(env, input_count);

    {
        auto futures = std::vector<std::future<RGBImageData>>();
        futures.reserve(inputs.Length());
        for (auto i = 0; i < input_count; i++) {
            auto input = inputs[i].AsValue().As<Napi::Buffer<uint8_t>>();
            futures.push_back(pool.submit_task(avif_decode_rgba_impl, std::span(input.Data(), input.Length()), max_thread));
        }

        helpers::future::drain_futures(futures, [&](RGBImageData&& rgb, size_t i) {
            auto object = Napi::Object::New(env);
            object.Set("width", Napi::Number::New(env, rgb.data().width));
            object.Set("height", Napi::Number::New(env, rgb.data().height));
            object.Set("data", rgb.make_buffer(env));
            outputs[i] = object;
        });
    }

    return outputs;
}
} // namespace node_api::imaging
