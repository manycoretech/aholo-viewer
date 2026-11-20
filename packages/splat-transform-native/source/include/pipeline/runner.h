#pragma once
#include <io/file.h>
#include <io/json.h>
#include <pipeline/path_resolver.h>

namespace splat_transform::pipeline {
void run(const io::Json& pipeline, const std::filesystem::path& pipeline_file = {});
bool modify(splat::Splat& data, const io::Json& config, const PathResolver& paths = PathResolver());
} // namespace splat_transform::pipeline
