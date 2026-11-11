#pragma once
#include <cstdint>
#include <span>
#include <splat/splat.h>
#include <splat/splat_block.h>
#include <vector>

namespace splat_transform::splat::lod {
namespace detail {
Splat reduce_gaussians(size_t id, const Splat& splat, size_t target_count, float scale_boost, size_t max_step);
}

struct SplatLod {
    std::vector<Splat> splats;
    std::vector<uint32_t> levels;
};

struct SplatLevelParameters {
    float precision;
    float scale_boost;
};

struct Block {
    Eigen::AlignedBox3f bounds;
    std::vector<uint32_t> references;
};

struct BlockedSplat {
    std::vector<Splat> splats;
    std::vector<Block> blocks;
};

void generate_lod(size_t id, SplatLod& lod, std::span<const SplatLevelParameters> parameters, size_t min_size, size_t max_step);
BlockedSplat generate_blocked_lod(Splat input, std::span<const SplatLevelParameters> parameters, float precision, block::SplitNormal normal);
} // namespace splat_transform::splat::lod
