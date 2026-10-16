#pragma once
#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <span>
#include <splat/splat.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace splat_transform::io {
using Bytes = std::vector<uint8_t>;
using Json = nlohmann::ordered_json;
using Archive = std::map<std::string, Bytes>;

inline Json bounds_json(const Eigen::AlignedBox3f& bounds) {
    return { { "min", { bounds.min().x(), bounds.min().y(), bounds.min().z() } },
        { "max", { bounds.max().x(), bounds.max().y(), bounds.max().z() } } };
}

class ByteReader {
public:
    explicit ByteReader(std::span<const uint8_t> bytes) : bytes_(bytes) {}
    size_t remaining() const { return bytes_.size() - offset_; }
    std::span<const uint8_t> take(size_t count) {
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
        std::array<uint8_t, sizeof(T)> bytes;
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
    std::span<const uint8_t> bytes_;
    size_t offset_ = 0;
};

template<typename T>
void append(Bytes& output, T value) {
    auto bytes = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
    if constexpr (std::endian::native != std::endian::little) {
        std::ranges::reverse(bytes);
    }
    output.insert(output.end(), bytes.begin(), bytes.end());
}

std::filesystem::path utf8_path(const std::string& path);
std::string path_utf8(const std::filesystem::path& path);
Bytes read_bytes(const std::filesystem::path& path);
void write_bytes(const std::filesystem::path& path, std::span<const uint8_t> bytes);
Json read_json(const std::filesystem::path& path);
Bytes zip(const Archive& files);
float from_half(uint16_t value);
uint16_t to_half(float value);

splat::Splat read_splat(const std::filesystem::path& path, unsigned max_sh_degree = 3);
void write_splat(const std::filesystem::path& path, const splat::Splat& data, const Json& options = Json::object());

struct FileInput {
    std::filesystem::path path;
    std::span<const uint8_t> bytes;
    unsigned max_sh_degree = 3;
    unsigned retained_degree(unsigned degree) const {
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
    virtual splat::Splat read(const std::filesystem::path& path, unsigned max_sh_degree) const;
    virtual Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const;
    virtual void write(const std::filesystem::path& path, const splat::Splat& splat, std::span<const uint32_t> indices) const;
    virtual bool requires_gpu() const noexcept { return false; }
    virtual bool preserve_bundle_order() const noexcept { return false; }
};
enum class FileOperation {
    Read,
    Write,
};
std::unique_ptr<IFile> create_file(std::string_view extension, const Json& options = Json::object(), FileOperation operation = FileOperation::Read);
splat::Splat read_splat(const FileInput& input);
} // namespace splat_transform::io
