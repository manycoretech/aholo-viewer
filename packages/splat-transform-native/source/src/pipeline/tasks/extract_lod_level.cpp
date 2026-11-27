#include "../data_support.h"
#include <algorithm>
#include <limits>
#include <pipeline/tasks/extract_lod_level.h>
#include <unordered_map>
#include <utility/logger.h>

namespace splat_transform::pipeline {
void ExtractLodLevelTask::exec(const io::Json& config, TaskContext& context) const {
    const auto output = config.at("output").get<std::string>();
    const auto level = config.at("level").get<size_t>();
    const auto* bundle = std::get_if<std::vector<SingleFile>>(&context.input(config));
    if (!bundle) {
        throw std::runtime_error("ExtractLodLevel requires an in-memory LOD bundle");
    }
    const std::string* metadata = nullptr;
    std::unordered_map<std::string, const splat::Splat*> chunks;
    for (const auto& file : *bundle) {
        if (file.name == "lod-meta.json") {
            if (metadata || !std::holds_alternative<std::string>(file.content)) {
                throw std::runtime_error("ExtractLodLevel requires one text lod-meta.json");
            }
            metadata = &std::get<std::string>(file.content);
        } else if (const auto* data = std::get_if<SplatPtr>(&file.content)) {
            if (!*data || !chunks.emplace(file.name, data->get()).second) {
                throw std::runtime_error("ExtractLodLevel found a null or duplicate chunk");
            }
        }
    }
    if (!metadata) {
        throw std::runtime_error("ExtractLodLevel lod-meta.json is missing");
    }
    const auto meta = io::Json::parse(*metadata);
    const auto levels = meta.at("levels").get<size_t>();
    const auto degree = std::min(meta.at("shDegree").get<uint32_t>(), splat::MAX_SH_DEGREE);
    if (level >= levels) {
        throw std::runtime_error("ExtractLodLevel level is out of range");
    }
    const auto& files = meta.at("files");
    const auto& tree = meta.at("tree");
    if (!files.is_array() || !tree.is_array()) {
        throw std::runtime_error("ExtractLodLevel files and tree must be arrays");
    }
    for (const auto& name : files) {
        if (!name.is_string() || !chunks.contains(name.get<std::string>())) {
            throw std::runtime_error("ExtractLodLevel metadata references a missing chunk");
        }
    }
    struct Range {
        const splat::Splat* data;
        size_t offset;
        size_t count;
    };
    std::vector<Range> ranges;
    size_t total = 0;
    for (const auto& node : tree) {
        const auto& lods = node.at("lods");
        if (!lods.is_array() || level >= lods.size()) {
            throw std::runtime_error("ExtractLodLevel tree node is missing the requested level");
        }
        const auto& ref = lods.at(level);
        const auto file = ref.at("file").get<size_t>();
        const auto offset = ref.at("offset").get<size_t>();
        const auto count = ref.at("count").get<size_t>();
        if (file >= files.size()) {
            throw std::runtime_error("ExtractLodLevel file index is out of range");
        }
        const auto* data = chunks.at(files.at(file).get<std::string>());
        if (data->sh_degree != degree) {
            throw std::runtime_error("ExtractLodLevel chunk SH degrees must match metadata");
        }
        if (offset > data->size() || count > data->size() - offset) {
            throw std::runtime_error("ExtractLodLevel interval exceeds chunk size");
        }
        if (count > std::numeric_limits<uint32_t>::max() - total) {
            throw std::runtime_error("ExtractLodLevel result exceeds the supported splat count");
        }
        total += count;
        ranges.push_back({ data, offset, count });
    }
    auto result = std::make_shared<splat::Splat>();
    result->sh_degree = degree;
    result->gaussians.reserve(total);
    for (const auto& range : ranges) {
        const auto points = std::span(range.data->gaussians).subspan(range.offset, range.count);
        result->gaussians.insert(result->gaussians.end(), points.begin(), points.end());
    }
    single_block(*result);
    context.set(config, std::move(result));
    utility::logger().info("extracted L", level, " -> \"", output, "\" count=", total, " SH=", degree);
}
} // namespace splat_transform::pipeline
