#include "lod_support.h"
#include <io/resource.h>
#include <splat/splat_lod.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::pipeline {
using io::Json;
float number(const Json& config, const char* key, float fallback) {
    return config.contains(key) && config.at(key).is_number() ? config.at(key).get<float>() : fallback;
}
splat::block::SplitNormal split_normal(const Json& config) {
    if (!config.contains("splitNormal")) {
        return splat::block::SplitNormal::None;
    }
    const auto& value = config.at("splitNormal");
    if (value.is_number_integer()) {
        int normal = value.get<int>();
        if (normal >= 0 && normal <= 3) {
            return static_cast<splat::block::SplitNormal>(normal);
        }
    } else if (value.is_string()) {
        constexpr std::array<std::string_view, 4> NAMES { "none", "x", "y", "z" };
        const auto found = std::ranges::find(NAMES, io::lower(value.get<std::string>()));
        if (found != NAMES.end()) {
            return static_cast<splat::block::SplitNormal>(found - NAMES.begin());
        }
    }
    throw std::runtime_error("Invalid splitNormal");
}
BlockedSplat generate(splat::Splat input, const Json& levels, float precision, splat::block::SplitNormal normal) {
    BlockedSplat output;
    if (!input.size()) {
        output.splats.push_back(std::move(input));
        output.blocks.push_back({ Eigen::AlignedBox3f(Eigen::Vector3f::Zero(), Eigen::Vector3f::Zero()), std::vector<uint32_t>(levels.size(), 0) });
        return output;
    }
    if (!(precision > 0 && precision <= 1) || levels.empty()) {
        throw std::runtime_error("Invalid LOD configuration");
    }
    input.prepare_lod();
    auto blocks = splat::block::split(std::move(input), precision, normal);
    std::vector<splat::lod::SplatLevelParameters> parameters;
    for (size_t i = 1; i < levels.size(); ++i) {
        parameters.push_back({ levels[i].at("precision").get<float>(), levels[i].value("scaleBoost", 1.0f) });
    }
    auto& pool = threading::default_pool();
    threading::TaskGroup<splat::lod::SplatLod> futures(pool, blocks.size());
    for (size_t index = 0; index < blocks.size(); ++index) {
        futures.submit([&, index] {
            splat::lod::SplatLod lod;
            lod.splats.push_back(std::move(blocks[index]));
            lod.levels.push_back(0);
            if (!parameters.empty()) {
                splat::lod::generate_lod(index, lod, parameters, 2000, 20);
            }
            return lod;
        });
    }
    for (size_t index = 0; index < futures.size(); ++index) {
        auto lod = futures.get(index);
        Block block;
        block.bounds = lod.splats.front().bounding_box;
        const auto base = static_cast<uint32_t>(output.splats.size());
        for (auto ref : lod.levels) {
            block.references.push_back(base + ref);
        }
        for (auto& splat : lod.splats) {
            output.splats.push_back(std::move(splat));
        }
        output.blocks.push_back(std::move(block));
    }
    return output;
}
size_t target_count(const splat::Splat& data, const Json& config, float ratio, float count) {
    ratio = number(config, "ratio", ratio);
    count = number(config, "counts", count);
    const auto target = std::min(std::ceil(data.size() * ratio), count);
    if (!std::isfinite(target) || target < 0 || target > data.size()) {
        throw std::runtime_error("Invalid LOD target count");
    }
    utility::logger().info("expected -> ", static_cast<size_t>(target), '(', utility::fixed(target / data.size() * 100),
        "%) | ratio=", ratio, " counts=", utility::fixed(count, 0));
    return static_cast<size_t>(target);
}
} // namespace splat_transform::pipeline
