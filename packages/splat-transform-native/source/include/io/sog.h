#pragma once
#include <io/file.h>

namespace splat_transform::io {
class SogFile final : public IFile {
public:
    explicit SogFile(
        int32_t version = 2, size_t palette_size = 0, double color_error = FileOptions::default_color_error
    );
    std::string_view name() const noexcept override { return "SOG"; }
    uint32_t max_sh_degree() const noexcept override;
    splat::Splat read(const FileInput& input) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;
    bool requires_gpu() const noexcept override { return true; }
    bool preserve_bundle_order() const noexcept override { return true; }

private:
    static constexpr size_t palette_limit(int32_t version) { return version == 3 ? 262144 : 65536; }
    int32_t version_;
    size_t palette_size_;
    double color_error_;
};
} // namespace splat_transform::io
