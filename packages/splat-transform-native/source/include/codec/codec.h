#pragma once
#include <io/file.h>
#include <span>

namespace splat_transform::codec {
using io::Bytes;
struct Image {
    Bytes rgba;
    uint32_t width = 0;
    uint32_t height = 0;
};
Bytes gzip(std::span<const uint8_t> data, int level = 6);
Bytes gunzip(std::span<const uint8_t> data);
Bytes zstd_compress(std::span<const uint8_t> data, int level = 7);
Bytes zstd_decompress(std::span<const uint8_t> data);
Bytes encode_webp(std::span<const uint8_t> rgba, uint32_t width, uint32_t height, bool lossless = true, float quality = 70);
Image decode_webp(std::span<const uint8_t> bytes);
Bytes encode_avif(std::span<const uint8_t> rgba, uint32_t width, uint32_t height, int quality);
Image decode_avif(std::span<const uint8_t> bytes);
} // namespace splat_transform::codec
