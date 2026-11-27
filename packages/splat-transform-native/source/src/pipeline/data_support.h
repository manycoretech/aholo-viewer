#pragma once
#include <Eigen/Core>
#include <pipeline/context.h>

namespace splat_transform::pipeline {
Eigen::Vector3f read_vector3(const io::Json& value);
const splat::Splat& plain_splat(const Resource& resource);
void single_block(splat::Splat& data);
} // namespace splat_transform::pipeline
