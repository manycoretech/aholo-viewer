#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <span>

namespace splat_transform::codec {
// The producer fills an exact byte range. Parallel gzip jobs may call it
// concurrently, including the preceding 32 KiB used as a DEFLATE dictionary.
using ReadRange = std::function<void(size_t, std::span<uint8_t>)>;
using WriteChunk = std::function<void(std::span<const uint8_t>)>;
void gzip_stream(size_t size, const ReadRange& read, const WriteChunk& write, int level);
void zstd_stream(size_t size, const ReadRange& read, const WriteChunk& write, int level);
} // namespace splat_transform::codec
