#pragma once
#include <io/file.h>

namespace splat_transform::pipeline {
void run(const io::Json& pipeline);
void modify(splat::Splat& data, const io::Json& config);
} // namespace splat_transform::pipeline
