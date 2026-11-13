#pragma once
#include <io/file.h>

namespace splat_transform::io {
class SogFile final : public IFile {
public:
    explicit SogFile(int32_t version = 2, size_t palette_size = 0);
    std::string_view name() const noexcept override { return "SOG"; }
    splat::Splat read(const FileInput& input) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;
    bool requires_gpu() const noexcept override { return true; }
    bool preserve_bundle_order() const noexcept override { return true; }

private:
    int32_t version_;
    size_t palette_size_;
};
} // namespace splat_transform::io
