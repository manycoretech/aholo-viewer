#pragma once
#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>
#include <splat/splat.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace splat_transform::io {
using Bytes = std::vector<std::byte>;
using Archive = std::unordered_map<std::string, Bytes>;

class ByteReader {
public:
    explicit ByteReader(std::span<const std::byte> bytes) : bytes_(bytes) {}
    size_t remaining() const { return bytes_.size() - offset_; }
    std::span<const std::byte> take(size_t count) {
        if (count > remaining()) {
            throw std::runtime_error("Truncated input at byte " + std::to_string(offset_));
        }
        auto result = bytes_.subspan(offset_, count);
        offset_ += count;
        return result;
    }
    template<typename T>
    T read(bool little_endian = true) {
        auto input = take(sizeof(T));
        std::array<std::byte, sizeof(T)> bytes;
        std::ranges::copy(input, bytes.begin());
        if (little_endian != (std::endian::native == std::endian::little)) {
            std::ranges::reverse(bytes);
        }
        return std::bit_cast<T>(bytes);
    }
    template<typename T>
    T read_at(size_t offset, bool little_endian = true) const {
        if (offset > bytes_.size()) {
            throw std::runtime_error("Invalid binary offset");
        }
        return ByteReader(bytes_.subspan(offset)).read<T>(little_endian);
    }

private:
    std::span<const std::byte> bytes_;
    size_t offset_ = 0;
};

template<typename T>
void append(Bytes& output, T value) {
    auto bytes = std::bit_cast<std::array<std::byte, sizeof(T)>>(value);
    if constexpr (std::endian::native != std::endian::little) {
        std::ranges::reverse(bytes);
    }
    output.insert(output.end(), bytes.begin(), bytes.end());
}

std::filesystem::path utf8_path(const std::string& path);
std::string path_utf8(const std::filesystem::path& path);
std::string filesystem_error_message(const std::filesystem::filesystem_error& error);
Bytes read_bytes(const std::filesystem::path& path);
void write_bytes(const std::filesystem::path& path, std::span<const std::byte> bytes);
Bytes zip(const Archive& files);
float from_half(uint16_t value);
uint16_t to_half(float value);

splat::Splat read_splat(const std::filesystem::path& path, uint32_t max_sh_degree = 3);
struct FileOptions {
    int32_t spz_version = 3;
    int32_t spz_compress_level = 6;
    bool high_precision = false;
    bool enable_morton_sort = true;
};
void write_splat(const std::filesystem::path& path, const splat::Splat& data, const FileOptions& options = {});

struct FileInput {
    std::filesystem::path path;
    std::span<const std::byte> bytes;
    uint32_t max_sh_degree = 3;
    uint32_t retained_degree(uint32_t degree) const {
        if (degree > 3) {
            throw std::runtime_error("Unsupported SH degree");
        }
        return std::min(degree, max_sh_degree);
    }
};

class IFile {
public:
    virtual ~IFile() = default;
    virtual std::string_view name() const noexcept = 0;
    virtual splat::Splat read(const FileInput& input) const = 0;
    virtual splat::Splat read(const std::filesystem::path& path, uint32_t max_sh_degree) const;
    virtual Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const;
    virtual void write(const std::filesystem::path& path, const splat::Splat& splat, std::span<const uint32_t> indices) const;
    virtual bool requires_gpu() const noexcept { return false; }
    virtual bool preserve_bundle_order() const noexcept { return false; }
};
enum class FileOperation {
    Read,
    Write,
};
std::unique_ptr<IFile> create_file(std::string_view extension, const FileOptions& options = {}, FileOperation operation = FileOperation::Read);
splat::Splat read_splat(const FileInput& input);
} // namespace splat_transform::io
