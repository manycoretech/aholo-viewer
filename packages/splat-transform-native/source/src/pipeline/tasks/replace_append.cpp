#include "../data_support.h"
#include <pipeline/tasks/replace_append.h>
#include <unordered_map>
#include <utility/logger.h>

namespace splat_transform::pipeline {
void ReplaceAppendTask::exec(const io::Json& config, TaskContext& context) const {
    const auto output = config.at("output").get<std::string>();
    const auto& source = plain_splat(context.input(config));
    const auto& patch = plain_splat(context.input({ { "input", config.at("patch") } }));
    validate_layout(source);
    validate_layout(patch);
    if (source.sh_degree != patch.sh_degree) {
        throw std::runtime_error("ReplaceAppend source and patch SH degrees must match");
    }
    const auto indices = unique_indices(index_array(config.at("sourceIndices"), "sourceIndices"), source.size(), false);
    if (indices.size() > patch.size()) {
        throw std::runtime_error("ReplaceAppend sourceIndices length exceeds patch count");
    }
    const auto appended = patch.size() - indices.size();
    const auto source_count = source.size();
    if (appended > UINT32_MAX - source_count) {
        throw std::runtime_error("ReplaceAppend result exceeds the supported splat count");
    }
    std::unordered_map<uint32_t, size_t> replacements;
    for (size_t i = 0; i < indices.size(); ++i) {
        replacements.emplace(indices[i], i);
    }
    auto result = std::make_shared<splat::Splat>();
    result->sh_degree = source.sh_degree;
    result->gaussians.reserve(source_count + appended);
    for (size_t i = 0; i < source_count; ++i) {
        const auto replacement = replacements.find(static_cast<uint32_t>(i));
        result->gaussians.push_back(replacement == replacements.end() ? source.gaussians[i] : patch.gaussians[replacement->second]);
    }
    result->gaussians.insert(result->gaussians.end(), patch.gaussians.begin() + indices.size(), patch.gaussians.end());
    single_block(*result);
    context.set(config, std::move(result));
    utility::logger().info("replace-append stored -> key=\"", output, "\" source=", source_count, " replace=", indices.size(), " append=", appended);
}
} // namespace splat_transform::pipeline
