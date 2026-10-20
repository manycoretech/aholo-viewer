#pragma once
#include <Eigen/Core>
#include <concepts>
#include <cstddef>
#include <functional>

namespace splat_transform::utility {
struct VectorHash {
    template<std::integral Scalar, int Size>
    std::size_t operator()(const Eigen::Matrix<Scalar, Size, 1>& key) const noexcept {
        static_assert(Size != Eigen::Dynamic);
        std::size_t seed = 0;
        for (int i = 0; i < Size; ++i) {
            seed ^= std::hash<Scalar> {}(key[i]) + std::size_t { 0x9e3779b9 } + (seed << 6) + (seed >> 2);
        }
        return seed;
    }
};
} // namespace splat_transform::utility
