#include "../data_support.h"
#include <codec/codec.h>
#include <pipeline/tasks/select.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
namespace {
std::vector<uint32_t> load_indices(const io::Json& config, const PathResolver& paths) {
    if (config.contains("indices") == config.contains("indicesPath")) {
        throw std::runtime_error("Select requires exactly one of indices and indicesPath");
    }
    if (config.contains("indices")) {
        return config.at("indices").get<std::vector<uint32_t>>();
    }
    const auto path = paths.resolve(config.at("indicesPath").get<std::string>());
    if (path.extension() == ".json") {
        const auto value = io::read_json(path);
        return (value.is_array() ? value : value.at("indices")).get<std::vector<uint32_t>>();
    }
    auto bytes = io::read_bytes(path);
    if (path.extension() == ".zst") {
        bytes = codec::zstd_decompress(bytes);
    }
    if (bytes.size() % sizeof(uint32_t)) {
        throw std::runtime_error("Select indicesPath byte length must be a multiple of 4");
    }
    io::ByteReader reader(bytes);
    std::vector<uint32_t> result(bytes.size() / sizeof(uint32_t));
    for (auto& value : result) {
        value = reader.read<uint32_t>();
    }
    return result;
}
} // namespace
void SelectTask::exec(const io::Json& config, TaskContext& context) const {
    const auto output = config.at("output").get<std::string>();
    const auto& source = plain_splat(context.input(config));
    const auto indices = load_indices(config, context.paths);
    auto result = std::make_shared<splat::Splat>(source.select(indices));
    single_block(*result);
    const auto count = result->size();
    context.set(config, std::move(result));
    utility::logger().info("selected -> key=\"", output, "\" count=", count);
}
} // namespace splat_transform::pipeline
