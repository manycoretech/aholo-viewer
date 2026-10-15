#pragma once
#include <io/file.h>

namespace splat_transform::voxel {
void write(const splat::Splat& data, const std::filesystem::path& directory, const io::Json& config);
} // namespace splat_transform::voxel
