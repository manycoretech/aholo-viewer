#include "../data_support.h"
#include <pipeline/tasks/extract_lod_level.h>
#include <unordered_map>
#include <utility/logger.h>

namespace splat_transform::pipeline {
void ExtractLodLevelTask::exec(const io::Json& config, TaskContext& context) const {
    const auto output = config.at("output").get<std::string>();
    const auto level = unsigned_integer(config.at("level"), "level");
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
    const auto levels = unsigned_integer(meta.at("levels"), "levels");
    const auto degree = unsigned_integer(meta.at("shDegree"), "shDegree");
    if (level >= levels || degree > 3) {
        throw std::runtime_error("ExtractLodLevel level or SH degree is out of range");
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
        const auto file = unsigned_integer(ref.at("file"), "file");
        const auto offset = unsigned_integer(ref.at("offset"), "offset");
        const auto count = unsigned_integer(ref.at("count"), "count");
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
        if (count > UINT32_MAX - total) {
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
        for (const auto& point : points) {
            if (point.sh.size() != splat::SH_COUNTS[degree] + 3) {
                throw std::runtime_error("ExtractLodLevel chunk SH layout is inconsistent");
            }
            result->gaussians.push_back(point);
        }
    }
    single_block(*result);
    context.set(config, std::move(result));
    utility::logger().info("extracted L", level, " -> \"", output, "\" count=", total, " SH=", degree);
}
} // namespace splat_transform::pipeline
