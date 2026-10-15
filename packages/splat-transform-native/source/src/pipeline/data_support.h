#pragma once
#include <pipeline/context.h>

namespace splat_transform::pipeline {
uint32_t unsigned_integer(const io::Json& value, std::string_view field);
std::vector<uint32_t> index_array(const io::Json& value, std::string_view field);
std::vector<uint32_t> unique_indices(std::vector<uint32_t> indices, size_t count, bool deduplicate);
const splat::Splat& plain_splat(const Resource& resource);
void validate_layout(const splat::Splat& data);
void single_block(splat::Splat& data);
} // namespace splat_transform::pipeline
