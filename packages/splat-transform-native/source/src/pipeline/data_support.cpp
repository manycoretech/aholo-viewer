#include "data_support.h"
#include <array>

namespace splat_transform::pipeline {
Eigen::Vector3f read_vector3(const io::Json& value) {
    std::array<float, 3> coordinates;
    if (value.is_object()) {
        coordinates = { value.at("x").get<float>(), value.at("y").get<float>(), value.at("z").get<float>() };
    } else {
        value.get_to(coordinates);
    }
    return Eigen::Map<const Eigen::Vector3f>(coordinates.data());
}
const splat::Splat& plain_splat(const Resource& resource) {
    const auto* pointer = std::get_if<SplatPtr>(&resource);
    if (!pointer || !*pointer) {
        throw std::runtime_error("Task requires a plain splat resource");
    }
    return **pointer;
}
void single_block(splat::Splat& data) {
    data.block_offsets = { 0 };
    data.block_counts = { data.size() };
    data.compute_bounding_box();
}
} // namespace splat_transform::pipeline
