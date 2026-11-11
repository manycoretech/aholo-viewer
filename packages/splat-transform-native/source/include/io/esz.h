#pragma once
#include <cstdint>
#include <io/file.h>

namespace splat_transform::io {
class EszFile final : public IFile {
public:
    explicit EszFile(bool high_precision = false) : high_precision_(high_precision) {}
    std::string_view name() const noexcept override { return "ESZ"; }
    splat::Splat read(const FileInput& input) const override;
    splat::Splat read(const std::filesystem::path& path, uint32_t max_sh_degree) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;

private:
    bool high_precision_;
};
} // namespace splat_transform::io
