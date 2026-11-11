#include "../lod_support.h"
#include <array>
#include <pipeline/tasks/auto_lod.h>
#include <splat/splat_lod.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
using io::Json;
void AutoLodTask::exec(const Json& config, TaskContext& context) const {
    auto data = context.take_splat(config);
    auto& logger = utility::logger();
    logger.info("loaded -> \"", config.at("input").get<std::string>(), '"');
    const auto target = target_count(data, config, 0.3f, std::numeric_limits<float>::infinity());
    const std::array levels {
        splat::lod::SplatLevelParameters { 1.0f, 1.0f },
        splat::lod::SplatLevelParameters { data.size() ? float(target) / data.size() : 0, 1.0f }
    };
    auto blocked = splat::lod::generate_blocked_lod(std::move(data), levels, 0.2f, split_normal(config));
    std::vector<splat::Splat> parts;
    for (const auto& block : blocked.blocks) {
        parts.push_back(std::move(blocked.splats[block.references[1]]));
    }
    auto result = std::make_shared<splat::Splat>(splat::combine(std::move(parts)));
    logger.info("result -> ", result->size(), '(', utility::fixed(float(result->size()) / target * 100), "%)");
    context.set(config, std::move(result));
    logger.info("stored -> key=\"", config.at("output").get<std::string>(), '"');
}
} // namespace splat_transform::pipeline
