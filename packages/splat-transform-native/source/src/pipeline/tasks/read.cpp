#include <pipeline/tasks/read.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
using io::Json;
void ReadTask::exec(const Json& config, TaskContext& context) const {
    std::vector<splat::Splat> parts;
    const auto& inputs = config.at("inputs");
    parts.reserve(inputs.size());
    const auto max_sh = config.value("maxShDegree", 3u);
    uintmax_t total_bytes = 0;
    for (const auto& input : inputs) {
        const auto path = io::utf8_path(input.get<std::string>());
        total_bytes += std::filesystem::file_size(path);
        parts.push_back(io::read_splat(path, max_sh));
    }
    auto data = std::make_shared<splat::Splat>(parts.size() == 1 ? std::move(parts.front()) : splat::combine(std::move(parts), true));
    auto& logger = utility::logger();
    logger.info("load: ", inputs.size(), " files | sizes=", utility::fixed(float(total_bytes) / (1024 * 1024)), "MB");
    for (const auto& input : inputs) {
        logger.info("  - ", input.get<std::string>());
    }
    logger.info("counts: ", data->size(), ", SH: ", data->sh_degree);
    context.set(config, std::move(data));
    logger.info("stored -> \"", config.at("output").get<std::string>(), '"');
}
} // namespace splat_transform::pipeline
