#pragma once
#include <functional>
#include <io/file.h>
#include <limits>
#include <utility/thread_pool.h>

namespace splat_transform::io {
// Spans are borrowed until the next read. Callers must join parallel decoding
// before advancing the reader. Compressed readers retain only a bounded window.
class StreamReader {
public:
    using Read = std::function<size_t(std::span<uint8_t>)>;
    explicit StreamReader(const std::filesystem::path& path, size_t buffer_size = 1024 * 1024);
    explicit StreamReader(std::span<const uint8_t> bytes, size_t buffer_size = 1024 * 1024);
    explicit StreamReader(Read read, size_t buffer_size = 1024 * 1024);
    size_t remaining() const { return remaining_; }
    std::span<const uint8_t> peek(size_t count);
    std::span<const uint8_t> take(size_t count);
    std::span<const uint8_t> read_some(size_t maximum);
    void skip(size_t count);
    void require_end();
    template<typename T>
    T read(bool little = true) { return ByteReader(take(sizeof(T))).read<T>(little); }

private:
    void fill(size_t minimum);
    Read read_;
    Bytes buffer_;
    size_t buffer_size_, remaining_ = std::numeric_limits<size_t>::max(), begin_ = 0, end_ = 0;
};

StreamReader gzip_reader(StreamReader& source);
StreamReader zstd_reader(StreamReader& source, size_t compressed_size = std::numeric_limits<size_t>::max());

template<typename F>
void parallel_rows(size_t rows, F&& run) {
    if (rows < 65536) {
        run(0, rows);
        return;
    }
    auto& pool = threading::default_pool();
    const size_t step = std::max(size_t(8192), (rows + pool.thread_count() - 1) / pool.thread_count());
    threading::TaskGroup<void> pending(pool, pool.thread_count());
    for (size_t begin = 0; begin < rows; begin += step) {
        pending.submit(run, begin, std::min(rows, begin + step));
    }
    for (size_t i = 0; i < pending.size(); ++i) {
        pending.get(i);
    }
}
template<typename F>
void decode_records(StreamReader& reader, size_t count, size_t stride, F&& decode) {
    constexpr size_t BATCH_BYTES = 8 * 1024 * 1024;
    const size_t batch_rows = std::max(size_t(1), BATCH_BYTES / stride);
    for (size_t first = 0; first < count;) {
        const size_t rows = std::min(batch_rows, count - first);
        const auto bytes = reader.take(rows * stride);
        const auto run = [&](size_t begin, size_t end) {
            decode(bytes.subspan(begin * stride, (end - begin) * stride), first + begin, end - begin);
        };
        parallel_rows(rows, run);
        first += rows;
    }
}
} // namespace splat_transform::io
