#include "compression_stream.h"
#include <algorithm>
#include <array>
#include <codec/codec.h>
#include <limits>
#include <utility/thread_pool.h>
#include <zlib.h>
// The shared-pool API is provided for the statically linked, pinned zstd build.
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>

namespace splat_transform::codec {
namespace {
class ZlibStream {
public:
    explicit ZlibStream(bool encode, int level, int window_bits = 31) : encode_(encode) {
        const int status = encode ? deflateInit2(&stream, level, Z_DEFLATED, window_bits, 8, Z_DEFAULT_STRATEGY) : inflateInit2(&stream, 47);
        if (status != Z_OK) {
            throw std::runtime_error("Cannot initialize gzip stream");
        }
    }
    ~ZlibStream() {
        if (encode_) {
            deflateEnd(&stream);
        } else {
            inflateEnd(&stream);
        }
    }
    z_stream stream {};

private:
    bool encode_;
};
int compression_workers(size_t size, size_t job_size) {
    const auto available = threading::default_thread_count();
    return static_cast<int>(std::min(available, size / job_size));
}
struct GzipBlock {
    Bytes bytes;
    uLong checksum;
    size_t size;
};
GzipBlock compress_block(std::span<const uint8_t> data, std::span<const uint8_t> dictionary, int level, bool last) {
    ZlibStream state(true, level, -15);
    auto& stream = state.stream;
    if (!dictionary.empty() && deflateSetDictionary(&stream, dictionary.data(), uInt(dictionary.size())) != Z_OK) {
        throw std::runtime_error("Cannot set gzip dictionary");
    }
    GzipBlock result { Bytes(deflateBound(&stream, uLong(data.size())) + 16), crc32_z(0, data.data(), data.size()), data.size() };
    stream.next_in = const_cast<Bytef*>(data.data());
    stream.avail_in = uInt(data.size());
    stream.next_out = result.bytes.data();
    stream.avail_out = uInt(result.bytes.size());
    const int status = deflate(&stream, last ? Z_FINISH : Z_SYNC_FLUSH);
    if (status != (last ? Z_STREAM_END : Z_OK) || stream.avail_in || !stream.avail_out) {
        throw std::runtime_error("Cannot compress gzip block");
    }
    result.bytes.resize(stream.total_out);
    return result;
}
Bytes parallel_gzip(std::span<const uint8_t> data, int level, int workers) {
    // Byte-aligned raw DEFLATE blocks share the preceding 32 KiB dictionary.
    // Their concatenation is one gzip member, including one combined CRC32.
    constexpr size_t BLOCK_SIZE = 1024 * 1024;
    auto& pool = threading::default_pool();
    Bytes output { 0x1f, 0x8b, 8, 0, 0, 0, 0, 0, uint8_t(level == 9 ? 2 : level == 1 ? 4
                                                                                     : 0),
        255 };
    uLong checksum = 0;
    for (size_t offset = 0; offset < data.size();) {
        threading::TaskGroup<GzipBlock> pending(pool, size_t(workers));
        for (int i = 0; i < workers && offset < data.size(); ++i) {
            const size_t size = std::min(BLOCK_SIZE, data.size() - offset);
            const auto block = data.subspan(offset, size);
            const size_t dictionary_size = std::min(offset, size_t(32768));
            const auto dictionary = data.subspan(offset - dictionary_size, dictionary_size);
            offset += size;
            pending.submit(compress_block, block, dictionary, level, offset == data.size());
        }
        for (size_t i = 0; i < pending.size(); ++i) {
            auto block = pending.get(i);
            output.insert(output.end(), block.bytes.begin(), block.bytes.end());
            checksum = crc32_combine(checksum, block.checksum, z_off_t(block.size));
        }
    }
    io::append(output, uint32_t(checksum));
    io::append(output, uint32_t(data.size()));
    return output;
}
ZSTD_threadPool* zstd_pool() {
    // zstd exposes its own shared-pool type, not a user-supplied task executor.
    // Share one bounded pool across contexts instead of creating one per file.
    static const auto pool = std::unique_ptr<ZSTD_threadPool, decltype(&ZSTD_freeThreadPool)>(ZSTD_createThreadPool(threading::default_thread_count()), ZSTD_freeThreadPool);
    if (!pool) {
        throw std::bad_alloc();
    }
    return pool.get();
}
auto zstd_context(size_t size, int level) {
    auto context = std::unique_ptr<ZSTD_CCtx, decltype(&ZSTD_freeCCtx)>(ZSTD_createCCtx(), ZSTD_freeCCtx);
    if (!context) {
        throw std::bad_alloc();
    }
    auto parameter = [&](ZSTD_cParameter key, int value) {
        const auto status = ZSTD_CCtx_setParameter(context.get(), key, value);
        if (ZSTD_isError(status)) {
            throw std::runtime_error(ZSTD_getErrorName(status));
        }
    };
    parameter(ZSTD_c_compressionLevel, level);
    const auto workers = compression_workers(size, 4 * 1024 * 1024);
    if (workers > 1) {
        const auto status = ZSTD_CCtx_refThreadPool(context.get(), zstd_pool());
        if (ZSTD_isError(status)) {
            throw std::runtime_error(ZSTD_getErrorName(status));
        }
        parameter(ZSTD_c_nbWorkers, workers);
        parameter(ZSTD_c_jobSize, 4 * 1024 * 1024);
    }
    return context;
}
Bytes process_gzip(std::span<const uint8_t> input, bool encode, int level) {
    ZlibStream state(encode, level);
    auto& stream = state.stream;
    Bytes output;
    std::array<uint8_t, 131072> chunk;
    size_t offset = 0;
    for (;;) {
        if (!stream.avail_in && offset < input.size()) {
            const auto count = std::min(input.size() - offset, size_t(std::numeric_limits<uInt>::max()));
            stream.next_in = const_cast<Bytef*>(input.data() + offset);
            stream.avail_in = static_cast<uInt>(count);
            offset += count;
        }
        stream.next_out = chunk.data();
        stream.avail_out = static_cast<uInt>(chunk.size());
        const int status = encode ? deflate(&stream, offset == input.size() ? Z_FINISH : Z_NO_FLUSH) : inflate(&stream, Z_NO_FLUSH);
        output.insert(output.end(), chunk.begin(), chunk.begin() + (chunk.size() - stream.avail_out));
        if (status == Z_STREAM_END) {
            break;
        }
        if (status != Z_OK || (!encode && stream.avail_out == chunk.size() && !stream.avail_in && offset == input.size())) {
            throw std::runtime_error(stream.msg ? stream.msg : "Invalid or truncated gzip stream");
        }
    }
    return output;
}
} // namespace
Bytes gzip(std::span<const uint8_t> data, int level) {
    const auto workers = compression_workers(data.size(), 1024 * 1024);
    return workers > 1 ? parallel_gzip(data, level, workers) : process_gzip(data, true, level);
}
Bytes gunzip(std::span<const uint8_t> data) { return process_gzip(data, false, 0); }
Bytes zstd_compress(std::span<const uint8_t> data, int level) {
    auto context = zstd_context(data.size(), level);
    Bytes result(ZSTD_compressBound(data.size()));
    const auto size = ZSTD_compress2(context.get(), result.data(), result.size(), data.data(), data.size());
    if (ZSTD_isError(size)) {
        throw std::runtime_error(ZSTD_getErrorName(size));
    }
    result.resize(size);
    return result;
}
void gzip_stream(size_t size, const ReadRange& read, const WriteChunk& write, int level) {
    constexpr size_t BLOCK_SIZE = 1024 * 1024;
    const auto workers = compression_workers(size, BLOCK_SIZE);
    if (workers > 1) {
        const std::array<uint8_t, 10> header { 0x1f, 0x8b, 8, 0, 0, 0, 0, 0, uint8_t(level == 9 ? 2 : level == 1 ? 4
                                                                                                                 : 0),
            255 };
        write(header);
        auto& pool = threading::default_pool();
        uLong checksum = 0;
        for (size_t offset = 0; offset < size;) {
            threading::TaskGroup<GzipBlock> pending(pool, size_t(workers));
            for (int i = 0; i < workers && offset < size; ++i) {
                const size_t count = std::min(BLOCK_SIZE, size - offset);
                pending.submit([&, offset, count] {
                    const size_t dictionary_size = std::min(offset, size_t(32768));
                    Bytes input(dictionary_size + count);
                    read(offset - dictionary_size, input);
                    return compress_block(std::span(input).subspan(dictionary_size), std::span(input).first(dictionary_size), level, offset + count == size);
                });
                offset += count;
            }
            for (size_t i = 0; i < pending.size(); ++i) {
                auto block = pending.get(i);
                write(block.bytes);
                checksum = crc32_combine(checksum, block.checksum, z_off_t(block.size));
            }
        }
        Bytes trailer;
        io::append(trailer, uint32_t(checksum));
        io::append(trailer, uint32_t(size));
        write(trailer);
        return;
    }
    ZlibStream state(true, level);
    auto& stream = state.stream;
    Bytes input(std::min(size, size_t(128 * 1024)));
    std::array<uint8_t, 128 * 1024> output;
    size_t offset = 0;
    for (;;) {
        if (!stream.avail_in && offset < size) {
            const auto count = std::min(input.size(), size - offset);
            read(offset, std::span(input).first(count));
            stream.next_in = input.data();
            stream.avail_in = static_cast<uInt>(count);
            offset += count;
        }
        stream.next_out = output.data();
        stream.avail_out = static_cast<uInt>(output.size());
        const int status = deflate(&stream, offset == size ? Z_FINISH : Z_NO_FLUSH);
        write(std::span(output).first(output.size() - stream.avail_out));
        if (status == Z_STREAM_END) {
            return;
        }
        if (status != Z_OK) {
            throw std::runtime_error(stream.msg ? stream.msg : "Cannot compress gzip stream");
        }
    }
}
void zstd_stream(size_t size, const ReadRange& read, const WriteChunk& write, int level) {
    auto context = zstd_context(size, level);
    const auto pledged = ZSTD_CCtx_setPledgedSrcSize(context.get(), size);
    if (ZSTD_isError(pledged)) {
        throw std::runtime_error(ZSTD_getErrorName(pledged));
    }
    Bytes input(std::min(size, size_t(8 * 1024 * 1024)));
    Bytes output(ZSTD_CStreamOutSize());
    size_t offset = 0;
    do {
        const size_t count = std::min(input.size(), size - offset);
        read(offset, std::span(input).first(count));
        offset += count;
        ZSTD_inBuffer in { input.data(), count, 0 };
        const auto directive = offset == size ? ZSTD_e_end : ZSTD_e_continue;
        size_t remaining;
        do {
            ZSTD_outBuffer out { output.data(), output.size(), 0 };
            remaining = ZSTD_compressStream2(context.get(), &out, &in, directive);
            if (ZSTD_isError(remaining)) {
                throw std::runtime_error(ZSTD_getErrorName(remaining));
            }
            write(std::span(output).first(out.pos));
        } while (in.pos < in.size || (directive == ZSTD_e_end && remaining));
    } while (offset < size);
}
Bytes zstd_decompress(std::span<const uint8_t> data) {
    auto stream = std::unique_ptr<ZSTD_DStream, decltype(&ZSTD_freeDStream)>(ZSTD_createDStream(), ZSTD_freeDStream);
    if (!stream) {
        throw std::bad_alloc();
    }
    auto status = ZSTD_initDStream(stream.get());
    if (ZSTD_isError(status)) {
        throw std::runtime_error(ZSTD_getErrorName(status));
    }
    Bytes result;
    std::vector<uint8_t> chunk(ZSTD_DStreamOutSize());
    ZSTD_inBuffer input { data.data(), data.size(), 0 };
    do {
        ZSTD_outBuffer output { chunk.data(), chunk.size(), 0 };
        const auto previous = input.pos;
        status = ZSTD_decompressStream(stream.get(), &output, &input);
        if (ZSTD_isError(status)) {
            throw std::runtime_error(ZSTD_getErrorName(status));
        }
        result.insert(result.end(), chunk.begin(), chunk.begin() + output.pos);
        if (status && input.pos == previous && !output.pos) {
            throw std::runtime_error("Truncated zstd stream");
        }
    } while (input.pos < input.size || status);
    return result;
}
} // namespace splat_transform::codec
