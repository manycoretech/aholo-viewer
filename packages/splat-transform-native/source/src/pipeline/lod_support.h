#pragma once
#include <pipeline/context.h>
#include <splat/splat_block.h>

namespace splat_transform::pipeline {
struct Block {
    Eigen::AlignedBox3f bounds;
    std::vector<uint32_t> references;
};
struct BlockedSplat {
    std::vector<splat::Splat> splats;
    std::vector<Block> blocks;
};
float number(const io::Json& config, const char* key, float fallback);
splat::block::SplitNormal split_normal(const io::Json& config);
BlockedSplat generate(splat::Splat input, const io::Json& levels, float precision, splat::block::SplitNormal normal);
size_t target_count(const splat::Splat& splat, const io::Json& config, float ratio, float count);
} // namespace splat_transform::pipeline
