#pragma once
#include <splat/splat.h>
#include <type_traits>
#include <vector>

namespace splat::block {
enum class SplitNormal : uint8_t {
    None,
    X,
    Y,
    Z
};
namespace detail {
std::vector<Splat> split(const Splat& splat, size_t max_block_size, SplitNormal normal);
} // namespace detail

template<typename T>
    requires std::is_same_v<std::remove_reference_t<T>, Splat>
std::vector<Splat> split(T&& input, double precision, SplitNormal normal) {
    auto max_block_size = static_cast<size_t>(static_cast<double>(input.gaussians.size()) * precision);
    return detail::split(input, max_block_size, normal);
}
} // namespace splat::block
