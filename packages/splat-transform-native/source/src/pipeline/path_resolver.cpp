#include <io/file.h>
#include <pipeline/path_resolver.h>
#include <string_view>
#include <utility/logger.h>

namespace splat_transform::pipeline {
PathResolver::PathResolver(const io::Json& config, const std::filesystem::path& pipeline_file)
    : work_dir_(std::filesystem::current_path()), pipeline_dir_(pipeline_file.empty() ? this->work_dir_ : std::filesystem::absolute(pipeline_file).parent_path()) {
    auto version = config.value("version", 2);
    if (version != 1 && version != 2) {
        utility::logger().warn("Unrecognized pipeline version ", version, ". Using version 2.");
        version = 2;
    }
    const auto default_base = version == 2 && !pipeline_file.empty() ? "pipelineDir" : "workDir";
    auto base = config.value<std::string_view>("base", default_base);
    if (base != "pipelineDir" && base != "workDir") {
        utility::logger().warn("Unrecognized pipeline base ", base, ". Using pipelineDir.");
        base = "pipelineDir";
    }
    this->use_pipeline_dir_ = base == "pipelineDir";
}

std::filesystem::path PathResolver::resolve(const std::string& path) const {
    if (path.empty()) {
        return {};
    }
    constexpr std::string_view WORK_DIR = "${workDir}";
    constexpr std::string_view PIPELINE_DIR = "${pipelineDir}";
    std::string_view rest(path);
    std::string expanded;
    for (auto start = rest.find("${"); start != rest.npos; start = rest.find("${")) {
        expanded.append(rest.substr(0, start));
        rest.remove_prefix(start);
        if (rest.starts_with(WORK_DIR)) {
            expanded += io::path_utf8(this->work_dir_);
            rest.remove_prefix(WORK_DIR.size());
        } else if (rest.starts_with(PIPELINE_DIR)) {
            expanded += io::path_utf8(this->pipeline_dir_);
            rest.remove_prefix(PIPELINE_DIR.size());
        } else {
            expanded += "${";
            rest.remove_prefix(2);
        }
    }
    expanded.append(rest);
    const auto& base = this->use_pipeline_dir_ ? this->pipeline_dir_ : this->work_dir_;
    return std::filesystem::absolute(base / io::utf8_path(expanded)).lexically_normal();
}
} // namespace splat_transform::pipeline
