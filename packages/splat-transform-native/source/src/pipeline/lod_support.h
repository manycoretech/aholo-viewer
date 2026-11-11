#pragma once
#include <pipeline/context.h>
#include <splat/splat_block.h>

namespace splat_transform::pipeline {
float number(const io::Json& config, const char* key, float fallback);
splat::block::SplitNormal split_normal(const io::Json& config);
size_t target_count(const splat::Splat& splat, const io::Json& config, float ratio, float count);
} // namespace splat_transform::pipeline
