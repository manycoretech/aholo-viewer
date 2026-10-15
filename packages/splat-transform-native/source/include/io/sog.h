#pragma once
#include <io/file.h>

namespace splat_transform::io {
class SogFile final : public IFile {
public:
    std::string_view name() const noexcept override { return "SOG"; }
    splat::Splat read(const FileInput& input) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;
    bool requires_gpu() const noexcept override { return true; }
    bool preserve_bundle_order() const noexcept override { return true; }
};
} // namespace splat_transform::io
