#include "data_support.h"
#include <cmath>
#include <unordered_set>

namespace splat_transform::pipeline {
uint32_t unsigned_integer(const io::Json& value, std::string_view field) {
    if (!value.is_number()) {
        throw std::runtime_error(std::string(field) + " must be a nonnegative 32-bit integer");
    }
    // Check the JSON number before narrowing; float cannot represent every uint32_t index.
    const double number = value.get<double>();
    if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
        throw std::runtime_error(std::string(field) + " must be a nonnegative 32-bit integer");
    }
    return static_cast<uint32_t>(number);
}
std::vector<uint32_t> index_array(const io::Json& value, std::string_view field) {
    if (!value.is_array()) {
        throw std::runtime_error(std::string(field) + " must be an array");
    }
    std::vector<uint32_t> result;
    result.reserve(value.size());
    for (const auto& item : value) {
        result.push_back(unsigned_integer(item, field));
    }
    return result;
}
std::vector<uint32_t> unique_indices(std::vector<uint32_t> indices, size_t count, bool deduplicate) {
    std::unordered_set<uint32_t> seen;
    seen.reserve(indices.size());
    size_t size = 0;
    for (const auto index : indices) {
        if (index >= count) {
            throw std::runtime_error("Splat index out of range: " + std::to_string(index));
        }
        if (seen.insert(index).second) {
            indices[size++] = index;
        } else if (!deduplicate) {
            throw std::runtime_error("Duplicate source index: " + std::to_string(index));
        }
    }
    indices.resize(size);
    return indices;
}
const splat::Splat& plain_splat(const Resource& resource) {
    const auto* pointer = std::get_if<SplatPtr>(&resource);
    if (!pointer || !*pointer) {
        throw std::runtime_error("Task requires a plain splat resource");
    }
    return **pointer;
}
void validate_layout(const splat::Splat& data) {
    if (data.sh_degree > 3 || data.size() > UINT32_MAX) {
        throw std::runtime_error("Unsupported splat size or SH degree");
    }
    for (const auto& point : data.gaussians) {
        if (point.sh.size() != data.sh_count() + 3) {
            throw std::runtime_error("Inconsistent splat SH layout");
        }
    }
}
void single_block(splat::Splat& data) {
    data.block_offsets = { 0 };
    data.block_counts = { data.size() };
    data.compute_bounding_box();
}
} // namespace splat_transform::pipeline
