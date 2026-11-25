#pragma once
#include <cstdint>
#include <io/file.h>

namespace splat_transform::io {
class EszFile final : public IFile {
public:
    explicit EszFile(bool high_precision = false, ShBits sh_bits = FileOptions::default_sh_bits)
        : high_precision_(high_precision), sh_bits_(high_precision ? high_precision_rgb_bits : clamp_sh_bits(sh_bits)) {}
    std::string_view name() const noexcept override { return "ESZ"; }
    splat::Splat read(const FileInput& input) const override;
    splat::Splat read(const std::filesystem::path& path, uint32_t max_sh_degree) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;

private:
    static constexpr ShBits high_precision_rgb_bits { 11, 10, 11 };
    bool high_precision_;
    // The high layout fixes the RGB widths of every coefficient. Low layout widths are per degree.
    ShBits sh_bits_;
};
} // namespace splat_transform::io
