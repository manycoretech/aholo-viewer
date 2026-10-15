#pragma once
#include <splat/splat.h>
#include <vector>

namespace splat_transform::splat::block {
enum class SplitNormal : uint8_t {
    None,
    X,
    Y,
    Z
};
// Consume the input so blocks can take ownership of its Gaussian and ShCoefficients storage.
std::vector<Splat> split(Splat&& input, float precision, SplitNormal normal);
} // namespace splat_transform::splat::block
