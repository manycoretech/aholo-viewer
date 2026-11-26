#include "stream_reader.h"
#include "file_stream.h"
#include <cstring>
#include <zlib.h>
#include <zstd.h>

namespace splat_transform::io {
namespace {
struct GzipState {
    explicit GzipState(StreamReader& input) : source(input) {
        if (inflateInit2(&this->stream, 47) != Z_OK) {
            throw std::runtime_error("Cannot initialize gzip stream");
        }
    }
    ~GzipState() { inflateEnd(&this->stream); }
    size_t read(std::span<std::byte> output) {
        if (this->finished) {
            return 0;
        }
        const size_t capacity = std::min(output.size(), static_cast<size_t>(std::numeric_limits<uInt>::max()));
        this->stream.next_out = reinterpret_cast<Bytef*>(output.data());
        this->stream.avail_out = static_cast<uInt>(capacity);
        while (this->stream.avail_out) {
            if (!this->stream.avail_in && !this->input_ended) {
                const auto input = this->source.read_some(128 * 1024);
                if (input.empty()) {
                    this->input_ended = true;
                }
                this->stream.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(input.data()));
                this->stream.avail_in = static_cast<uInt>(input.size());
            }
            const auto before = this->stream.avail_out;
            const auto status = inflate(&this->stream, Z_NO_FLUSH);
            if (status == Z_STREAM_END) {
                this->finished = true;
                break;
            }
            if (status != Z_OK || (this->input_ended && before == this->stream.avail_out)) {
                throw std::runtime_error(this->stream.msg ? this->stream.msg : "Invalid gzip stream");
            }
        }
        return capacity - this->stream.avail_out;
    }
    StreamReader& source;
    z_stream stream {};
    bool finished = false, input_ended = false;
};
struct ZstdState {
    ZstdState(StreamReader& input, size_t length)
        : source(input), remaining(length), stream(ZSTD_createDStream(), ZSTD_freeDStream) {
        if (!this->stream || ZSTD_isError(ZSTD_initDStream(this->stream.get()))) {
            throw std::runtime_error("Cannot initialize Zstd stream");
        }
    }
    size_t read(std::span<std::byte> output) {
        ZSTD_outBuffer out { output.data(), output.size(), 0 };
        while (out.pos < out.size) {
            if (this->input.pos == this->input.size && !this->input_ended) {
                const auto bytes = this->source.read_some(std::min(this->remaining, static_cast<size_t>(128 * 1024)));
                if (bytes.empty()) {
                    if (this->remaining != 0 && this->bounded) {
                        throw std::runtime_error("Truncated SPZ compressed stream");
                    }
                    this->input_ended = true;
                }
                this->remaining -= bytes.size();
                this->input = { bytes.data(), bytes.size(), 0 };
            }
            if (this->input_ended && this->finished_frame) {
                break;
            }
            const auto before = out.pos;
            const auto status = ZSTD_decompressStream(this->stream.get(), &out, &this->input);
            if (ZSTD_isError(status)) {
                throw std::runtime_error(ZSTD_getErrorName(status));
            }
            this->finished_frame = status == 0;
            if (this->input_ended && !this->finished_frame && out.pos == before) {
                throw std::runtime_error("Truncated Zstd stream");
            }
        }
        return out.pos;
    }
    StreamReader& source;
    size_t remaining;
    bool bounded = this->remaining != std::numeric_limits<size_t>::max();
    std::unique_ptr<ZSTD_DStream, decltype(&ZSTD_freeDStream)> stream;
    ZSTD_inBuffer input {};
    bool finished_frame = false, input_ended = false;
};
} // namespace

StreamReader::StreamReader(Read read, size_t buffer_size) : read_(std::move(read)), buffer_size_(buffer_size) {}
StreamReader::StreamReader(const std::filesystem::path& path, size_t buffer_size) : buffer_size_(buffer_size) {
    auto stream = std::make_shared<FileStream>(path, FileStream::Access::Read);
    this->remaining_ = stream->size();
    this->read_ = [stream](std::span<std::byte> target) { return stream->read(target); };
}
StreamReader::StreamReader(std::span<const std::byte> bytes, size_t buffer_size)
    : read_([bytes](std::span<std::byte> target) mutable {
          const size_t count = std::min(bytes.size(), target.size());
          std::copy_n(bytes.begin(), count, target.begin());
          bytes = bytes.subspan(count);
          return count;
      }),
      buffer_size_(buffer_size), remaining_(bytes.size()) {}

void StreamReader::fill(size_t minimum) {
    if (minimum <= this->end_ - this->begin_) {
        return;
    }
    const size_t available = this->end_ - this->begin_;
    if (available) {
        std::memmove(this->buffer_.data(), this->buffer_.data() + this->begin_, available);
    }
    this->buffer_.resize(std::max(minimum, std::min(this->remaining_, this->buffer_size_)));
    this->begin_ = 0;
    this->end_ = available;
    while (this->end_ < minimum) {
        const size_t capacity = std::min(this->buffer_.size() - this->end_, this->remaining_ - this->end_);
        const size_t count = capacity ? this->read_(std::span(this->buffer_).subspan(this->end_, capacity)) : 0;
        if (count > capacity) {
            throw std::runtime_error("Invalid input stream read length");
        }
        this->end_ += count;
        if (!count) {
            this->remaining_ = this->end_;
            break;
        }
    }
}
std::span<const std::byte> StreamReader::peek(size_t count) {
    if (count > this->remaining_) {
        throw std::runtime_error("Truncated input stream");
    }
    this->fill(count);
    if (count > this->end_ - this->begin_) {
        throw std::runtime_error("Truncated input stream");
    }
    return std::span<const std::byte>(this->buffer_).subspan(this->begin_, count);
}
std::span<const std::byte> StreamReader::take(size_t count) {
    auto result = this->peek(count);
    this->begin_ += count;
    this->remaining_ -= count;
    return result;
}
std::span<const std::byte> StreamReader::read_some(size_t maximum) {
    if (!maximum || !this->remaining_) {
        return {};
    }
    this->fill(1);
    return this->take(std::min(maximum, this->end_ - this->begin_));
}
void StreamReader::skip(size_t count) {
    while (count) {
        const auto bytes = this->read_some(std::min(count, this->buffer_size_));
        if (bytes.empty()) {
            throw std::runtime_error("Truncated input stream");
        }
        count -= bytes.size();
    }
}
void StreamReader::require_end() {
    if (!this->read_some(1).empty()) {
        throw std::runtime_error("Unexpected trailing decoded data");
    }
}
StreamReader gzip_reader(StreamReader& source) {
    auto state = std::make_shared<GzipState>(source);
    return StreamReader([state](std::span<std::byte> output) { return state->read(output); });
}
StreamReader zstd_reader(StreamReader& source, size_t compressed_size) {
    auto state = std::make_shared<ZstdState>(source, compressed_size);
    return StreamReader([state](std::span<std::byte> output) { return state->read(output); });
}
} // namespace splat_transform::io
