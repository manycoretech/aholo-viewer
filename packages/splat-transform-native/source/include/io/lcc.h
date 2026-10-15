#pragma once
#include <io/file.h>

namespace splat_transform::io {
class LccFile final : public IFile {
public:
    std::string_view name() const noexcept override { return "LCC"; }
    splat::Splat read(const FileInput& input) const override;
};
} // namespace splat_transform::io
