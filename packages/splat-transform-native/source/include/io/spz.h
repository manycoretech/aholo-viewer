#pragma once
#include <io/file.h>

namespace splat_transform::io {
class SpzFile final : public IFile {
public:
    explicit SpzFile(int version = 3, int compression_level = 6) : version_(version), compression_level_(compression_level) {}
    std::string_view name() const noexcept override { return "SPZ"; }
    splat::Splat read(const FileInput& input) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;

private:
    int version_;
    int compression_level_;
};
} // namespace splat_transform::io
