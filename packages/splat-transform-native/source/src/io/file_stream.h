#pragma once
#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>

namespace splat_transform::io {
// The blocking facade keeps format parsers independent of the native file
// backend. macOS and unavailable io_uring kernels use the Asio file executor.
class FileStream {
public:
    enum class Access { Read,
        Write };
    enum class Backend { Automatic,
        ThreadPool };
    FileStream(const std::filesystem::path& path, Access access, Backend backend = Backend::Automatic);
    ~FileStream();
    FileStream(const FileStream&) = delete;
    FileStream& operator=(const FileStream&) = delete;
    size_t size() const;
    bool uses_native_backend() const noexcept;
    size_t read(std::span<uint8_t> target);
    void write(std::span<const uint8_t> bytes);
    void seek(size_t offset);
    void close();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::io
