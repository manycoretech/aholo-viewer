#pragma once
#include <io/file.h>
#include <memory>

namespace splat_transform::io {
std::string lower(std::string value);
std::string normalized(std::string value);

// Resource paths are relative to metadata, including within ZIP archives.
class Resources {
public:
    Resources(const std::filesystem::path& path, std::span<const uint8_t> bytes, const std::string& format);
    ~Resources();
    std::string resolve(const std::string& name) const;
    Bytes read(const std::string& name) const;
    Json meta;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace splat_transform::io
