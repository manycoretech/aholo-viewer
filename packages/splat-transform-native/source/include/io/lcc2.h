#pragma once
#include <io/file.h>

namespace splat_transform::io {
class Lcc2File final : public IFile {
public:
    std::string_view name() const noexcept override { return "LCC2"; }
    splat::Splat read(const FileInput& input) const override;
};
} // namespace splat_transform::io
