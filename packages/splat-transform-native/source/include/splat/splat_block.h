#pragma once
#include <splat/splat.h>
#include <utility>
#include <vector>

namespace splat::block {
enum class SplitNormal : uint8_t {
    None,
    X,
    Y,
    Z
};
namespace detail {
std::vector<Splat> split(Splat&& splat, size_t max_block_size, SplitNormal normal);
} // namespace detail

// Consume the input so blocks can take ownership of its Gaussian and SH storage.
inline std::vector<Splat> split(Splat&& input, double precision, SplitNormal normal) {
    auto max_block_size = static_cast<size_t>(static_cast<double>(input.gaussians.size()) * precision);
    return detail::split(std::move(input), max_block_size, normal);
}
} // namespace splat::block
