#pragma once
#include <cstdint>
#include <io/file.h>

namespace splat_transform::io {
class SpzFile final : public IFile {
public:
    explicit SpzFile(int32_t version = 3, int32_t compression_level = 6)
        : version_(version == 4 ? 4 : 3), compression_level_(compression_level) {}
    std::string_view name() const noexcept override { return "SPZ"; }
    splat::Splat read(const FileInput& input) const override;
    splat::Splat read(const std::filesystem::path& path, uint32_t max_sh_degree) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;
    void write(const std::filesystem::path& path, const splat::Splat& splat, std::span<const uint32_t> indices) const override;

private:
    int32_t version_;
    int32_t compression_level_;
};
} // namespace splat_transform::io
