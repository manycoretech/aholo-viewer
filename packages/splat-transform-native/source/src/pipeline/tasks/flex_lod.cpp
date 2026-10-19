#include "../lod_support.h"
#include <numeric>
#include <pipeline/tasks/flex_lod.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
using io::Json;
void FlexLodTask::exec(const Json& config, TaskContext& context) const {
    auto data = context.take_splat(config);
    auto& logger = utility::logger();
    logger.info("loaded -> \"", config.at("input").get<std::string>(), '"');
    const auto target = target_count(data, config, 0.3f, std::numeric_limits<float>::infinity());
    auto bytes = io::read_bytes(io::utf8_path(config.at("scorePath").get<std::string>()));
    if (bytes.size() < data.size() * 4) {
        throw std::runtime_error("Score file is too short");
    }
    io::ByteReader reader(bytes);
    std::vector<float> scores(data.size());
    for (auto& value : scores) {
        value = reader.read<float>();
    }
    std::vector<uint32_t> indices(data.size());
    std::iota(indices.begin(), indices.end(), 0);
    std::ranges::stable_sort(indices, std::ranges::greater {}, [&](uint32_t index) { return scores[index]; });
    indices.resize(target);
    std::ranges::sort(indices);
    if (config.contains("originalIndices")) {
        io::Bytes output;
        for (auto index : indices) {
            io::append(output, index);
        }
        const auto path = io::utf8_path(config.at("originalIndices").get<std::string>());
        io::write_bytes(path, output);
        logger.info("original indices saved -> \"", io::path_utf8(path), '"');
    }
    context.set(config, std::make_shared<splat::Splat>(std::move(data).select(indices)));
    logger.info("stored -> key=\"", config.at("output").get<std::string>(), '"');
}
} // namespace splat_transform::pipeline
