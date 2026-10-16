#include "stream_reader.h"
#include "file_stream.h"
#include <cstring>
#include <zlib.h>
#include <zstd.h>

namespace splat_transform::io {
namespace {
struct GzipState {
    explicit GzipState(StreamReader& input) : source(input) {
        if (inflateInit2(&stream, 47) != Z_OK) {
            throw std::runtime_error("Cannot initialize gzip stream");
        }
    }
    ~GzipState() { inflateEnd(&stream); }
    size_t read(std::span<uint8_t> output) {
        if (finished) {
            return 0;
        }
        const size_t capacity = std::min(output.size(), size_t(std::numeric_limits<uInt>::max()));
        stream.next_out = output.data();
        stream.avail_out = static_cast<uInt>(capacity);
        while (stream.avail_out) {
            if (!stream.avail_in && !input_ended) {
                const auto input = source.read_some(128 * 1024);
                if (input.empty()) {
                    input_ended = true;
                }
                stream.next_in = const_cast<Bytef*>(input.data());
                stream.avail_in = static_cast<uInt>(input.size());
            }
            const auto before = stream.avail_out;
            const auto status = inflate(&stream, Z_NO_FLUSH);
            if (status == Z_STREAM_END) {
                finished = true;
                break;
            }
            if (status != Z_OK || (input_ended && before == stream.avail_out)) {
                throw std::runtime_error(stream.msg ? stream.msg : "Invalid gzip stream");
            }
        }
        return capacity - stream.avail_out;
    }
    StreamReader& source;
    z_stream stream {};
    bool finished = false, input_ended = false;
};
struct ZstdState {
    ZstdState(StreamReader& input, size_t length) : source(input), remaining(length), stream(ZSTD_createDStream(), ZSTD_freeDStream) {
        if (!stream || ZSTD_isError(ZSTD_initDStream(stream.get()))) {
            throw std::runtime_error("Cannot initialize Zstd stream");
        }
    }
    size_t read(std::span<uint8_t> output) {
        ZSTD_outBuffer out { output.data(), output.size(), 0 };
        while (out.pos < out.size) {
            if (input.pos == input.size && !input_ended) {
                const auto bytes = source.read_some(std::min(remaining, size_t(128 * 1024)));
                if (bytes.empty()) {
                    if (remaining != 0 && bounded) {
                        throw std::runtime_error("Truncated SPZ compressed stream");
                    }
                    input_ended = true;
                }
                remaining -= bytes.size();
                input = { bytes.data(), bytes.size(), 0 };
            }
            if (input_ended && finished_frame) {
                break;
            }
            const auto before = out.pos;
            const auto status = ZSTD_decompressStream(stream.get(), &out, &input);
            if (ZSTD_isError(status)) {
                throw std::runtime_error(ZSTD_getErrorName(status));
            }
            finished_frame = status == 0;
            if (input_ended && !finished_frame && out.pos == before) {
                throw std::runtime_error("Truncated Zstd stream");
            }
        }
        return out.pos;
    }
    StreamReader& source;
    size_t remaining;
    bool bounded = remaining != std::numeric_limits<size_t>::max();
    std::unique_ptr<ZSTD_DStream, decltype(&ZSTD_freeDStream)> stream;
    ZSTD_inBuffer input {};
    bool finished_frame = false, input_ended = false;
};
} // namespace

StreamReader::StreamReader(Read read, size_t buffer_size) : read_(std::move(read)), buffer_size_(buffer_size) {}
StreamReader::StreamReader(const std::filesystem::path& path, size_t buffer_size) : buffer_size_(buffer_size) {
    auto stream = std::make_shared<FileStream>(path, FileStream::Access::Read);
    remaining_ = stream->size();
    read_ = [stream](std::span<uint8_t> target) { return stream->read(target); };
}
StreamReader::StreamReader(std::span<const uint8_t> bytes, size_t buffer_size)
    : read_([bytes](std::span<uint8_t> target) mutable {
          const size_t count = std::min(bytes.size(), target.size());
          std::copy_n(bytes.begin(), count, target.begin());
          bytes = bytes.subspan(count);
          return count;
      }),
      buffer_size_(buffer_size), remaining_(bytes.size()) {}

void StreamReader::fill(size_t minimum) {
    if (minimum <= end_ - begin_) {
        return;
    }
    const size_t available = end_ - begin_;
    if (available) {
        std::memmove(buffer_.data(), buffer_.data() + begin_, available);
    }
    buffer_.resize(std::max(minimum, std::min(remaining_, buffer_size_)));
    begin_ = 0;
    end_ = available;
    while (end_ < minimum) {
        const size_t capacity = std::min(buffer_.size() - end_, remaining_ - end_);
        const size_t count = capacity ? read_(std::span(buffer_).subspan(end_, capacity)) : 0;
        if (count > capacity) {
            throw std::runtime_error("Invalid input stream read length");
        }
        end_ += count;
        if (!count) {
            remaining_ = end_;
            break;
        }
    }
}
std::span<const uint8_t> StreamReader::peek(size_t count) {
    if (count > remaining_) {
        throw std::runtime_error("Truncated input stream");
    }
    fill(count);
    if (count > end_ - begin_) {
        throw std::runtime_error("Truncated input stream");
    }
    return std::span<const uint8_t>(buffer_).subspan(begin_, count);
}
std::span<const uint8_t> StreamReader::take(size_t count) {
    auto result = peek(count);
    begin_ += count;
    remaining_ -= count;
    return result;
}
std::span<const uint8_t> StreamReader::read_some(size_t maximum) {
    if (!maximum || !remaining_) {
        return {};
    }
    fill(1);
    return take(std::min(maximum, end_ - begin_));
}
void StreamReader::skip(size_t count) {
    while (count) {
        const auto bytes = read_some(std::min(count, buffer_size_));
        if (bytes.empty()) {
            throw std::runtime_error("Truncated input stream");
        }
        count -= bytes.size();
    }
}
void StreamReader::require_end() {
    if (!read_some(1).empty()) {
        throw std::runtime_error("Unexpected trailing decoded data");
    }
}
StreamReader gzip_reader(StreamReader& source) {
    auto state = std::make_shared<GzipState>(source);
    return StreamReader([state](std::span<uint8_t> output) { return state->read(output); });
}
StreamReader zstd_reader(StreamReader& source, size_t compressed_size) {
    auto state = std::make_shared<ZstdState>(source, compressed_size);
    return StreamReader([state](std::span<uint8_t> output) { return state->read(output); });
}
} // namespace splat_transform::io
