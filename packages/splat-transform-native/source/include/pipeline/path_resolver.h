#pragma once
#include <filesystem>
#include <io/json.h>
#include <string>

namespace splat_transform::pipeline {
class PathResolver {
public:
    // An empty pipeline filename denotes stdin or a config supplied in memory.
    explicit PathResolver(const io::Json& config = io::Json::object(), const std::filesystem::path& pipeline_file = {});
    std::filesystem::path resolve(const std::string& path) const;
    const std::filesystem::path& work_dir() const { return this->work_dir_; }
    const std::filesystem::path& pipeline_dir() const { return this->pipeline_dir_; }

private:
    std::filesystem::path work_dir_;
    std::filesystem::path pipeline_dir_;
    bool use_pipeline_dir_;
};
} // namespace splat_transform::pipeline
