#pragma once
#include <io/file.h>

namespace splat_transform::voxel {
bool requires_gpu(const io::Json& config);
void write(const splat::Splat& data, const std::filesystem::path& directory, const io::Json& config);
} // namespace splat_transform::voxel
