#pragma once
#include <cstdint>
#include <io/file.h>
#include <span>

namespace splat_transform::codec {
using io::Bytes;
struct Image {
    Bytes rgba;
    uint32_t width = 0;
    uint32_t height = 0;
};
Bytes gzip(std::span<const std::byte> data, int32_t level = 6);
Bytes gunzip(std::span<const std::byte> data);
Bytes zstd_compress(std::span<const std::byte> data, int32_t level = 7);
Bytes zstd_decompress(std::span<const std::byte> data);
Bytes encode_webp(std::span<const std::byte> rgba, uint32_t width, uint32_t height, bool lossless = true, float quality = 70);
Image decode_webp(std::span<const std::byte> bytes);
Bytes encode_avif(std::span<const std::byte> rgba, uint32_t width, uint32_t height, int32_t quality);
Image decode_avif(std::span<const std::byte> bytes);
} // namespace splat_transform::codec
