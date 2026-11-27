#include "../data_support.h"
#include <limits>
#include <pipeline/tasks/replace_append.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
void ReplaceAppendTask::exec(const io::Json& config, TaskContext& context) const {
    const auto output = config.at("output").get<std::string>();
    const auto& source = plain_splat(context.input(config));
    const auto& patch = plain_splat(context.input({ { "input", config.at("patch") } }));
    if (source.sh_degree != patch.sh_degree) {
        throw std::runtime_error("ReplaceAppend source and patch SH degrees must match");
    }
    const auto indices = config.at("sourceIndices").get<std::vector<uint32_t>>();
    if (indices.size() > patch.size()) {
        throw std::runtime_error("ReplaceAppend sourceIndices length exceeds patch count");
    }
    const auto appended = patch.size() - indices.size();
    const auto source_count = source.size();
    if (appended > std::numeric_limits<uint32_t>::max() - source_count) {
        throw std::runtime_error("ReplaceAppend result exceeds the supported splat count");
    }
    auto result = std::make_shared<splat::Splat>();
    result->sh_degree = source.sh_degree;
    result->gaussians.reserve(source_count + appended);
    result->gaussians.insert(result->gaussians.end(), source.gaussians.begin(), source.gaussians.end());
    for (size_t i = 0; i < indices.size(); ++i) {
        result->gaussians.at(indices[i]) = patch.gaussians[i];
    }
    result->gaussians.insert(result->gaussians.end(), patch.gaussians.begin() + indices.size(), patch.gaussians.end());
    single_block(*result);
    context.set(config, std::move(result), false);
    utility::logger().info(
        "replace-append stored -> key=\"", output, "\" source=", source_count, " replace=", indices.size(),
        " append=", appended
    );
}
} // namespace splat_transform::pipeline
