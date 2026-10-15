#pragma once
#include <io/file.h>

namespace splat_transform::io {
class SplatFile final : public IFile {
public:
    std::string_view name() const noexcept override { return "SPLAT"; }
    splat::Splat read(const FileInput& input) const override;
    Bytes write(const splat::Splat& splat, std::span<const uint32_t> indices) const override;
};
} // namespace splat_transform::io
