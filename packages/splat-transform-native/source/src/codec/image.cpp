#include <avif/avif_cxx.h>
#include <codec/codec.h>
#include <memory>
#include <webp/decode.h>
#include <webp/encode.h>

namespace splat_transform::codec {
Bytes encode_webp(std::span<const uint8_t> rgba, uint32_t width, uint32_t height, bool lossless, float quality) {
    if (rgba.size() != size_t(width) * height * 4 || !width || !height) {
        throw std::runtime_error("Invalid WebP image dimensions");
    }
    WebPConfig config;
    WebPPicture picture;
    if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, quality) || !WebPPictureInit(&picture)) {
        throw std::runtime_error("Cannot initialize WebP encoder");
    }
    auto picture_guard = std::unique_ptr<WebPPicture, decltype(&WebPPictureFree)>(&picture, WebPPictureFree);
    WebPMemoryWriter writer;
    WebPMemoryWriterInit(&writer);
    auto writer_guard = std::unique_ptr<WebPMemoryWriter, decltype(&WebPMemoryWriterClear)>(&writer, WebPMemoryWriterClear);
    config.lossless = lossless;
    config.exact = 1;
    picture.use_argb = lossless;
    picture.width = static_cast<int>(width);
    picture.height = static_cast<int>(height);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;
    if (!WebPPictureImportRGBA(&picture, rgba.data(), static_cast<int>(4 * width)) || !WebPEncode(&config, &picture)) {
        throw std::runtime_error("WebP encode failed");
    }
    return Bytes(writer.mem, writer.mem + writer.size);
}
Image decode_webp(std::span<const uint8_t> bytes) {
    int width = 0, height = 0;
    auto pixels = std::unique_ptr<uint8_t, decltype(&WebPFree)>(WebPDecodeRGBA(bytes.data(), bytes.size(), &width, &height), WebPFree);
    if (!pixels) {
        throw std::runtime_error("WebP decode failed");
    }
    return { Bytes(pixels.get(), pixels.get() + size_t(width) * height * 4), static_cast<uint32_t>(width), static_cast<uint32_t>(height) };
}
Bytes encode_avif(std::span<const uint8_t> rgba, uint32_t width, uint32_t height, int quality) {
    if (rgba.size() != size_t(width) * height * 4) {
        throw std::runtime_error("Invalid AVIF image dimensions");
    }
    avif::ImagePtr image(avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV444));
    avif::EncoderPtr encoder(avifEncoderCreate());
    if (!image || !encoder) {
        throw std::bad_alloc();
    }
    avifRGBImage rgb {};
    avifRGBImageSetDefaults(&rgb, image.get());
    rgb.pixels = const_cast<uint8_t*>(rgba.data());
    rgb.rowBytes = width * 4;
    if (avifImageRGBToYUV(image.get(), &rgb) != AVIF_RESULT_OK) {
        throw std::runtime_error("AVIF RGB conversion failed");
    }
    encoder->quality = quality;
    encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    encoder->maxThreads = 1;
    avifRWData output = AVIF_DATA_EMPTY;
    auto guard = std::unique_ptr<avifRWData, decltype(&avifRWDataFree)>(&output, avifRWDataFree);
    if (avifEncoderAddImage(encoder.get(), image.get(), 1, AVIF_ADD_IMAGE_FLAG_SINGLE) != AVIF_RESULT_OK ||
        avifEncoderFinish(encoder.get(), &output) != AVIF_RESULT_OK) {
        throw std::runtime_error("AVIF encode failed");
    }
    return Bytes(output.data, output.data + output.size);
}
Image decode_avif(std::span<const uint8_t> bytes) {
    avif::DecoderPtr decoder(avifDecoderCreate());
    avif::ImagePtr image(avifImageCreateEmpty());
    if (!decoder || !image) {
        throw std::bad_alloc();
    }
    decoder->maxThreads = 1;
    if (avifDecoderReadMemory(decoder.get(), image.get(), bytes.data(), bytes.size()) != AVIF_RESULT_OK) {
        throw std::runtime_error("AVIF decode failed");
    }
    Image output { Bytes(size_t(image->width) * image->height * 4), image->width, image->height };
    avifRGBImage rgb {};
    avifRGBImageSetDefaults(&rgb, image.get());
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.pixels = output.rgba.data();
    rgb.rowBytes = output.width * 4;
    if (avifImageYUVToRGB(image.get(), &rgb) != AVIF_RESULT_OK) {
        throw std::runtime_error("AVIF YUV conversion failed");
    }
    return output;
}
} // namespace splat_transform::codec
