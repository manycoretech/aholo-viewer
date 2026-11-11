#include "lod_support.h"
#include <cstdint>
#include <io/resource.h>
#include <utility/logger.h>

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
        int32_t normal = value.get<int32_t>();
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
