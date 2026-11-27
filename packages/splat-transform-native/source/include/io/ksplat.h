#pragma once
#include <io/file.h>

namespace splat_transform::io {
class KsplatFile final : public IFile {
public:
    std::string_view name() const noexcept override { return "KSPLAT"; }
    uint32_t max_sh_degree() const noexcept override { return 3; }
    splat::Splat read(const FileInput& input) const override;
};
} // namespace splat_transform::io
