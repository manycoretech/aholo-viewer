#include "file_stream.h"
#include <algorithm>
#include <io/file.h>
#include <memory>
#include <zip.h>

namespace splat_transform::io {
std::filesystem::path utf8_path(const std::string& path) {
    return std::filesystem::u8path(path);
}
std::string path_utf8(const std::filesystem::path& path) {
    const auto value = path.generic_u8string();
    return std::string(value.begin(), value.end());
}
Bytes read_bytes(const std::filesystem::path& path) {
    FileStream stream(path, FileStream::Access::Read);
    Bytes bytes(stream.size());
    if (stream.read(bytes) != bytes.size()) {
        throw std::runtime_error("Cannot read complete input: " + path.string());
    }
    return bytes;
}
void write_bytes(const std::filesystem::path& path, std::span<const uint8_t> bytes) {
    FileStream stream(path, FileStream::Access::Write);
    stream.write(bytes);
    stream.close();
}
Json read_json(const std::filesystem::path& path) {
    const auto bytes = read_bytes(path);
    return Json::parse(bytes.begin(), bytes.end());
}
Bytes zip(const Archive& files) {
    zip_error_t error;
    zip_error_init(&error);
    auto error_guard = std::unique_ptr<zip_error_t, decltype(&zip_error_fini)>(&error, zip_error_fini);
    auto* source = zip_source_buffer_create(nullptr, 0, 0, &error);
    if (!source) {
        throw std::runtime_error(zip_error_strerror(&error));
    }
    auto* raw = zip_open_from_source(source, ZIP_CREATE | ZIP_TRUNCATE, &error);
    if (!raw) {
        zip_source_free(source);
        throw std::runtime_error(zip_error_strerror(&error));
    }
    auto archive = std::unique_ptr<zip_t, decltype(&zip_discard)>(raw, zip_discard);
    for (const auto& [name, bytes] : files) {
        auto* item = zip_source_buffer(raw, bytes.data(), bytes.size(), 0);
        if (!item) {
            throw std::runtime_error(zip_strerror(raw));
        }
        auto index = zip_file_add(raw, name.c_str(), item, ZIP_FL_ENC_UTF_8);
        if (index < 0) {
            zip_source_free(item);
            throw std::runtime_error(zip_strerror(raw));
        }
        zip_set_file_compression(raw, index, ZIP_CM_STORE, 0);
        zip_file_set_mtime(raw, index, 0, 0);
    }
    zip_source_keep(source);
    auto source_guard = std::unique_ptr<zip_source_t, decltype(&zip_source_free)>(source, zip_source_free);
    if (zip_close(raw) != 0) {
        throw std::runtime_error(zip_strerror(raw));
    }
    archive.release();
    zip_stat_t stat;
    zip_stat_init(&stat);
    if (zip_source_stat(source, &stat) != 0 || zip_source_open(source) != 0) {
        throw std::runtime_error("Cannot read generated ZIP");
    }
    Bytes result(static_cast<size_t>(stat.size));
    const auto size = zip_source_read(source, result.data(), result.size());
    zip_source_close(source);
    if (size < 0 || static_cast<size_t>(size) != result.size()) {
        throw std::runtime_error("Cannot finish generated ZIP");
    }
    return result;
}
float from_half(uint16_t value) {
    const auto sign = uint32_t(value & 0x8000) << 16;
    int exponent = (value >> 10) & 31;
    uint32_t fraction = value & 1023;
    uint32_t bits;
    if (!exponent) {
        if (!fraction) {
            bits = sign;
        } else {
            const int shift = 11 - std::bit_width(fraction);
            fraction <<= shift;
            exponent = -14 - shift;
            bits = sign | (uint32_t(exponent + 127) << 23) | ((fraction & 1023) << 13);
        }
    } else if (exponent == 31) {
        bits = sign | (fraction ? 0x7fc00000 : 0x7f800000);
    } else {
        bits = sign | (uint32_t(exponent + 112) << 23) | (fraction << 13);
    }
    return std::bit_cast<float>(bits);
}
uint16_t to_half(float value) {
    const uint32_t bits = std::bit_cast<uint32_t>(value);
    const uint32_t sign = (bits >> 16) & 0x8000;
    const int exponent = int((bits >> 23) & 255);
    const uint32_t fraction = bits & 0x7fffff;
    const int shifted = exponent - 112;
    if (exponent == 255) {
        return static_cast<uint16_t>(sign | (fraction ? 0x7fff : 0x7c00));
    }
    if (shifted >= 31) {
        return static_cast<uint16_t>(sign | 0x7c00);
    }
    if (shifted <= 0) {
        return static_cast<uint16_t>(sign | (shifted < -10 ? 0 : ((fraction | 0x800000) >> (14 - shifted))));
    }
    return static_cast<uint16_t>(sign | (uint32_t(shifted) << 10) | (fraction >> 13));
}
} // namespace splat_transform::io
