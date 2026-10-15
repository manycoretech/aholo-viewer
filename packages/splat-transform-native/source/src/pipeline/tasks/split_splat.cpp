#include "../lod_support.h"
#include <pipeline/tasks/split_splat.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
using io::Json;
void SplitSplatTask::exec(const Json& config, TaskContext& context) const {
    auto data = context.take_splat(config);
    const auto count = data.size();
    const auto max_count = number(config, "maxChunkCounts", 400000);
    if (max_count < 1) {
        throw std::runtime_error("maxChunkCounts must be positive");
    }
    auto& logger = utility::logger();
    logger.info("loaded -> \"", config.at("input").get<std::string>(), '"');
    logger.info("block precision -> ", max_count);
    logger.info("splitting splat");
    auto elapsed = logger.time("split elapsed");
    auto blocked = generate(std::move(data), Json::array({ { { "precision", 1.0f } } }), count ? std::min(1.0f, max_count / count) : 1, split_normal(config));
    elapsed.finish();
    std::vector<SingleFile> files;
    for (size_t i = 0; i < blocked.splats.size(); ++i) {
        files.push_back({ "block_" + std::to_string(i) + "." + config.at("type").get<std::string>(), std::make_shared<splat::Splat>(std::move(blocked.splats[i])) });
    }
    context.set(config, std::move(files));
}
} // namespace splat_transform::pipeline
