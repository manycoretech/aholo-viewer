#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <splat/splat.h>
#include <stdexcept>

// ShCoefficients rotation factors ported from the existing implementation.
// Original formulas: https://github.com/andrewwillmott/sh-lib
namespace splat_transform::spatial {
class ShRotation {
public:
    explicit ShRotation(const Eigen::Matrix3f& rotation) {
        const auto* rot = rotation.data();
        const float sqrt_03_02 = std::sqrt(3.0f / 2.0f);
        const float sqrt_01_03 = std::sqrt(1.0f / 3.0f);
        const float sqrt_02_03 = std::sqrt(2.0f / 3.0f);
        const float sqrt_04_03 = std::sqrt(4.0f / 3.0f);
        const float sqrt_01_04 = std::sqrt(1.0f / 4.0f);
        const float sqrt_03_04 = std::sqrt(3.0f / 4.0f);
        const float sqrt_01_05 = std::sqrt(1.0f / 5.0f);
        const float sqrt_03_05 = std::sqrt(3.0f / 5.0f);
        const float sqrt_06_05 = std::sqrt(6.0f / 5.0f);
        const float sqrt_08_05 = std::sqrt(8.0f / 5.0f);
        const float sqrt_09_05 = std::sqrt(9.0f / 5.0f);
        const float sqrt_01_06 = std::sqrt(1.0f / 6.0f);
        const float sqrt_05_06 = std::sqrt(5.0f / 6.0f);
        const float sqrt_03_08 = std::sqrt(3.0f / 8.0f);
        const float sqrt_05_08 = std::sqrt(5.0f / 8.0f);
        const float sqrt_09_08 = std::sqrt(9.0f / 8.0f);
        const float sqrt_05_09 = std::sqrt(5.0f / 9.0f);
        const float sqrt_08_09 = std::sqrt(8.0f / 9.0f);
        const float sqrt_01_10 = std::sqrt(1.0f / 10.0f);
        const float sqrt_03_10 = std::sqrt(3.0f / 10.0f);
        const float sqrt_01_12 = std::sqrt(1.0f / 12.0f);
        const float sqrt_04_15 = std::sqrt(4.0f / 15.0f);
        const float sqrt_01_16 = std::sqrt(1.0f / 16.0f);
        const float sqrt_15_16 = std::sqrt(15.0f / 16.0f);
        const float sqrt_01_18 = std::sqrt(1.0f / 18.0f);
        const float sqrt_01_60 = std::sqrt(1.0f / 60.0f);
        const float sh1[3][3] = {
            { rot[4], -rot[7], rot[1] },
            { -rot[5], rot[8], -rot[2] },
            { rot[3], -rot[6], rot[0] },
        };
        const float sh2[5][5] = {
            {
                sqrt_01_04 *
                    (sh1[2][2] * sh1[0][0] + sh1[2][0] * sh1[0][2] + (sh1[0][2] * sh1[2][0] + sh1[0][0] * sh1[2][2])),
                sh1[2][1] * sh1[0][0] + sh1[0][1] * sh1[2][0],
                sqrt_03_04 * (sh1[2][1] * sh1[0][1] + sh1[0][1] * sh1[2][1]),
                sh1[2][1] * sh1[0][2] + sh1[0][1] * sh1[2][2],
                sqrt_01_04 *
                    (sh1[2][2] * sh1[0][2] - sh1[2][0] * sh1[0][0] + (sh1[0][2] * sh1[2][2] - sh1[0][0] * sh1[2][0])),
            },
            {
                sqrt_01_04 *
                    (sh1[1][2] * sh1[0][0] + sh1[1][0] * sh1[0][2] + (sh1[0][2] * sh1[1][0] + sh1[0][0] * sh1[1][2])),
                sh1[1][1] * sh1[0][0] + sh1[0][1] * sh1[1][0],
                sqrt_03_04 * (sh1[1][1] * sh1[0][1] + sh1[0][1] * sh1[1][1]),
                sh1[1][1] * sh1[0][2] + sh1[0][1] * sh1[1][2],
                sqrt_01_04 *
                    (sh1[1][2] * sh1[0][2] - sh1[1][0] * sh1[0][0] + (sh1[0][2] * sh1[1][2] - sh1[0][0] * sh1[1][0])),
            },
            {
                sqrt_01_03 * (sh1[1][2] * sh1[1][0] + sh1[1][0] * sh1[1][2]) -
                    sqrt_01_12 *
                        (sh1[2][2] * sh1[2][0] + sh1[2][0] * sh1[2][2] + (sh1[0][2] * sh1[0][0] + sh1[0][0] * sh1[0][2])),
                sqrt_04_03 * sh1[1][1] * sh1[1][0] - sqrt_01_03 * (sh1[2][1] * sh1[2][0] + sh1[0][1] * sh1[0][0]),
                sh1[1][1] * sh1[1][1] - sqrt_01_04 * (sh1[2][1] * sh1[2][1] + sh1[0][1] * sh1[0][1]),
                sqrt_04_03 * sh1[1][1] * sh1[1][2] - sqrt_01_03 * (sh1[2][1] * sh1[2][2] + sh1[0][1] * sh1[0][2]),
                sqrt_01_03 * (sh1[1][2] * sh1[1][2] - sh1[1][0] * sh1[1][0]) -
                    sqrt_01_12 *
                        (sh1[2][2] * sh1[2][2] - sh1[2][0] * sh1[2][0] + (sh1[0][2] * sh1[0][2] - sh1[0][0] * sh1[0][0])),
            },
            {
                sqrt_01_04 *
                    (sh1[1][2] * sh1[2][0] + sh1[1][0] * sh1[2][2] + (sh1[2][2] * sh1[1][0] + sh1[2][0] * sh1[1][2])),
                sh1[1][1] * sh1[2][0] + sh1[2][1] * sh1[1][0],
                sqrt_03_04 * (sh1[1][1] * sh1[2][1] + sh1[2][1] * sh1[1][1]),
                sh1[1][1] * sh1[2][2] + sh1[2][1] * sh1[1][2],
                sqrt_01_04 *
                    (sh1[1][2] * sh1[2][2] - sh1[1][0] * sh1[2][0] + (sh1[2][2] * sh1[1][2] - sh1[2][0] * sh1[1][0])),
            },
            {
                sqrt_01_04 *
                    (sh1[2][2] * sh1[2][0] + sh1[2][0] * sh1[2][2] - (sh1[0][2] * sh1[0][0] + sh1[0][0] * sh1[0][2])),
                sh1[2][1] * sh1[2][0] - sh1[0][1] * sh1[0][0],
                sqrt_03_04 * (sh1[2][1] * sh1[2][1] - sh1[0][1] * sh1[0][1]),
                sh1[2][1] * sh1[2][2] - sh1[0][1] * sh1[0][2],
                sqrt_01_04 *
                    (sh1[2][2] * sh1[2][2] - sh1[2][0] * sh1[2][0] - (sh1[0][2] * sh1[0][2] - sh1[0][0] * sh1[0][0])),
            },
        };
        const float sh3[7][7] = {
            {
                sqrt_01_04 *
                    (sh1[2][2] * sh2[0][0] + sh1[2][0] * sh2[0][4] + (sh1[0][2] * sh2[4][0] + sh1[0][0] * sh2[4][4])),
                sqrt_03_02 * (sh1[2][1] * sh2[0][0] + sh1[0][1] * sh2[4][0]),
                sqrt_15_16 * (sh1[2][1] * sh2[0][1] + sh1[0][1] * sh2[4][1]),
                sqrt_05_06 * (sh1[2][1] * sh2[0][2] + sh1[0][1] * sh2[4][2]),
                sqrt_15_16 * (sh1[2][1] * sh2[0][3] + sh1[0][1] * sh2[4][3]),
                sqrt_03_02 * (sh1[2][1] * sh2[0][4] + sh1[0][1] * sh2[4][4]),
                sqrt_01_04 *
                    (sh1[2][2] * sh2[0][4] - sh1[2][0] * sh2[0][0] + (sh1[0][2] * sh2[4][4] - sh1[0][0] * sh2[4][0])),
            },
            {
                sqrt_01_06 * (sh1[1][2] * sh2[0][0] + sh1[1][0] * sh2[0][4]) +
                    sqrt_01_06 *
                        (sh1[2][2] * sh2[1][0] + sh1[2][0] * sh2[1][4] + (sh1[0][2] * sh2[3][0] + sh1[0][0] * sh2[3][4])),
                sh1[1][1] * sh2[0][0] + (sh1[2][1] * sh2[1][0] + sh1[0][1] * sh2[3][0]),
                sqrt_05_08 * sh1[1][1] * sh2[0][1] + sqrt_05_08 * (sh1[2][1] * sh2[1][1] + sh1[0][1] * sh2[3][1]),
                sqrt_05_09 * sh1[1][1] * sh2[0][2] + sqrt_05_09 * (sh1[2][1] * sh2[1][2] + sh1[0][1] * sh2[3][2]),
                sqrt_05_08 * sh1[1][1] * sh2[0][3] + sqrt_05_08 * (sh1[2][1] * sh2[1][3] + sh1[0][1] * sh2[3][3]),
                sh1[1][1] * sh2[0][4] + (sh1[2][1] * sh2[1][4] + sh1[0][1] * sh2[3][4]),
                sqrt_01_06 * (sh1[1][2] * sh2[0][4] - sh1[1][0] * sh2[0][0]) +
                    sqrt_01_06 *
                        (sh1[2][2] * sh2[1][4] - sh1[2][0] * sh2[1][0] + (sh1[0][2] * sh2[3][4] - sh1[0][0] * sh2[3][0])),
            },
            {
                sqrt_04_15 * (sh1[1][2] * sh2[1][0] + sh1[1][0] * sh2[1][4]) +
                    sqrt_01_05 * (sh1[0][2] * sh2[2][0] + sh1[0][0] * sh2[2][4]) -
                    sqrt_01_60 *
                        (sh1[2][2] * sh2[0][0] + sh1[2][0] * sh2[0][4] - (sh1[0][2] * sh2[4][0] + sh1[0][0] * sh2[4][4])),
                sqrt_08_05 * sh1[1][1] * sh2[1][0] +
                    sqrt_06_05 * sh1[0][1] * sh2[2][0] -
                    sqrt_01_10 * (sh1[2][1] * sh2[0][0] - sh1[0][1] * sh2[4][0]),
                sh1[1][1] * sh2[1][1] +
                    sqrt_03_04 * sh1[0][1] * sh2[2][1] -
                    sqrt_01_16 * (sh1[2][1] * sh2[0][1] - sh1[0][1] * sh2[4][1]),
                sqrt_08_09 * sh1[1][1] * sh2[1][2] +
                    sqrt_02_03 * sh1[0][1] * sh2[2][2] -
                    sqrt_01_18 * (sh1[2][1] * sh2[0][2] - sh1[0][1] * sh2[4][2]),
                sh1[1][1] * sh2[1][3] +
                    sqrt_03_04 * sh1[0][1] * sh2[2][3] -
                    sqrt_01_16 * (sh1[2][1] * sh2[0][3] - sh1[0][1] * sh2[4][3]),
                sqrt_08_05 * sh1[1][1] * sh2[1][4] +
                    sqrt_06_05 * sh1[0][1] * sh2[2][4] -
                    sqrt_01_10 * (sh1[2][1] * sh2[0][4] - sh1[0][1] * sh2[4][4]),
                sqrt_04_15 * (sh1[1][2] * sh2[1][4] - sh1[1][0] * sh2[1][0]) +
                    sqrt_01_05 * (sh1[0][2] * sh2[2][4] - sh1[0][0] * sh2[2][0]) -
                    sqrt_01_60 *
                        (sh1[2][2] * sh2[0][4] - sh1[2][0] * sh2[0][0] - (sh1[0][2] * sh2[4][4] - sh1[0][0] * sh2[4][0])),
            },
            {
                sqrt_03_10 * (sh1[1][2] * sh2[2][0] + sh1[1][0] * sh2[2][4]) -
                    sqrt_01_10 *
                        (sh1[2][2] * sh2[3][0] + sh1[2][0] * sh2[3][4] + (sh1[0][2] * sh2[1][0] + sh1[0][0] * sh2[1][4])),
                sqrt_09_05 * sh1[1][1] * sh2[2][0] - sqrt_03_05 * (sh1[2][1] * sh2[3][0] + sh1[0][1] * sh2[1][0]),
                sqrt_09_08 * sh1[1][1] * sh2[2][1] - sqrt_03_08 * (sh1[2][1] * sh2[3][1] + sh1[0][1] * sh2[1][1]),
                sh1[1][1] * sh2[2][2] - sqrt_01_03 * (sh1[2][1] * sh2[3][2] + sh1[0][1] * sh2[1][2]),
                sqrt_09_08 * sh1[1][1] * sh2[2][3] - sqrt_03_08 * (sh1[2][1] * sh2[3][3] + sh1[0][1] * sh2[1][3]),
                sqrt_09_05 * sh1[1][1] * sh2[2][4] - sqrt_03_05 * (sh1[2][1] * sh2[3][4] + sh1[0][1] * sh2[1][4]),
                sqrt_03_10 * (sh1[1][2] * sh2[2][4] - sh1[1][0] * sh2[2][0]) -
                    sqrt_01_10 *
                        (sh1[2][2] * sh2[3][4] - sh1[2][0] * sh2[3][0] + (sh1[0][2] * sh2[1][4] - sh1[0][0] * sh2[1][0])),
            },
            {
                sqrt_04_15 * (sh1[1][2] * sh2[3][0] + sh1[1][0] * sh2[3][4]) +
                    sqrt_01_05 * (sh1[2][2] * sh2[2][0] + sh1[2][0] * sh2[2][4]) -
                    sqrt_01_60 *
                        (sh1[2][2] * sh2[4][0] + sh1[2][0] * sh2[4][4] + (sh1[0][2] * sh2[0][0] + sh1[0][0] * sh2[0][4])),
                sqrt_08_05 * sh1[1][1] * sh2[3][0] +
                    sqrt_06_05 * sh1[2][1] * sh2[2][0] -
                    sqrt_01_10 * (sh1[2][1] * sh2[4][0] + sh1[0][1] * sh2[0][0]),
                sh1[1][1] * sh2[3][1] +
                    sqrt_03_04 * sh1[2][1] * sh2[2][1] -
                    sqrt_01_16 * (sh1[2][1] * sh2[4][1] + sh1[0][1] * sh2[0][1]),
                sqrt_08_09 * sh1[1][1] * sh2[3][2] +
                    sqrt_02_03 * sh1[2][1] * sh2[2][2] -
                    sqrt_01_18 * (sh1[2][1] * sh2[4][2] + sh1[0][1] * sh2[0][2]),
                sh1[1][1] * sh2[3][3] +
                    sqrt_03_04 * sh1[2][1] * sh2[2][3] -
                    sqrt_01_16 * (sh1[2][1] * sh2[4][3] + sh1[0][1] * sh2[0][3]),
                sqrt_08_05 * sh1[1][1] * sh2[3][4] +
                    sqrt_06_05 * sh1[2][1] * sh2[2][4] -
                    sqrt_01_10 * (sh1[2][1] * sh2[4][4] + sh1[0][1] * sh2[0][4]),
                sqrt_04_15 * (sh1[1][2] * sh2[3][4] - sh1[1][0] * sh2[3][0]) +
                    sqrt_01_05 * (sh1[2][2] * sh2[2][4] - sh1[2][0] * sh2[2][0]) -
                    sqrt_01_60 *
                        (sh1[2][2] * sh2[4][4] - sh1[2][0] * sh2[4][0] + (sh1[0][2] * sh2[0][4] - sh1[0][0] * sh2[0][0])),
            },
            {
                sqrt_01_06 * (sh1[1][2] * sh2[4][0] + sh1[1][0] * sh2[4][4]) +
                    sqrt_01_06 *
                        (sh1[2][2] * sh2[3][0] + sh1[2][0] * sh2[3][4] - (sh1[0][2] * sh2[1][0] + sh1[0][0] * sh2[1][4])),
                sh1[1][1] * sh2[4][0] + (sh1[2][1] * sh2[3][0] - sh1[0][1] * sh2[1][0]),
                sqrt_05_08 * sh1[1][1] * sh2[4][1] + sqrt_05_08 * (sh1[2][1] * sh2[3][1] - sh1[0][1] * sh2[1][1]),
                sqrt_05_09 * sh1[1][1] * sh2[4][2] + sqrt_05_09 * (sh1[2][1] * sh2[3][2] - sh1[0][1] * sh2[1][2]),
                sqrt_05_08 * sh1[1][1] * sh2[4][3] + sqrt_05_08 * (sh1[2][1] * sh2[3][3] - sh1[0][1] * sh2[1][3]),
                sh1[1][1] * sh2[4][4] + (sh1[2][1] * sh2[3][4] - sh1[0][1] * sh2[1][4]),
                sqrt_01_06 * (sh1[1][2] * sh2[4][4] - sh1[1][0] * sh2[4][0]) +
                    sqrt_01_06 *
                        (sh1[2][2] * sh2[3][4] - sh1[2][0] * sh2[3][0] - (sh1[0][2] * sh2[1][4] - sh1[0][0] * sh2[1][0])),
            },
            {
                sqrt_01_04 *
                    (sh1[2][2] * sh2[4][0] + sh1[2][0] * sh2[4][4] - (sh1[0][2] * sh2[0][0] + sh1[0][0] * sh2[0][4])),
                sqrt_03_02 * (sh1[2][1] * sh2[4][0] - sh1[0][1] * sh2[0][0]),
                sqrt_15_16 * (sh1[2][1] * sh2[4][1] - sh1[0][1] * sh2[0][1]),
                sqrt_05_06 * (sh1[2][1] * sh2[4][2] - sh1[0][1] * sh2[0][2]),
                sqrt_15_16 * (sh1[2][1] * sh2[4][3] - sh1[0][1] * sh2[0][3]),
                sqrt_03_02 * (sh1[2][1] * sh2[4][4] - sh1[0][1] * sh2[0][4]),
                sqrt_01_04 *
                    (sh1[2][2] * sh2[4][4] - sh1[2][0] * sh2[4][0] - (sh1[0][2] * sh2[0][4] - sh1[0][0] * sh2[0][0])),
            },
        };
        for (size_t r = 0; r < 3; ++r) {
            for (size_t c = 0; c < 3; ++c) {
                factors_[r][c] = sh1[r][c];
            }
        }
        for (size_t r = 0; r < 5; ++r) {
            for (size_t c = 0; c < 5; ++c) {
                factors_[r + 3][c + 3] = sh2[r][c];
            }
        }
        for (size_t r = 0; r < 7; ++r) {
            for (size_t c = 0; c < 7; ++c) {
                factors_[r + 8][c + 8] = sh3[r][c];
            }
        }
    }
    void apply(splat::ShCoefficients& sh) const {
        // Keep RGB interleaved. The stack copy protects inputs during in-place rotation.
        std::array<float, 45> source {};
        const size_t count = sh.size() > 3 ? (sh.size() - 3) / 3 : 0;
        if (count == 0) {
            return;
        }
        if (count != 3 && count != 8 && count != 15) {
            throw std::runtime_error("Unsupported SH coefficient count");
        }
        std::copy_n(sh.data() + 3, count * 3, source.begin());
        for (size_t row = 0; row < count; ++row) {
            std::array<float, 3> value {};
            for (size_t column = 0; column < count; ++column) {
                for (size_t c = 0; c < 3; ++c) {
                    value[c] += source[column * 3 + c] * factors_[row][column];
                }
            }
            for (size_t c = 0; c < 3; ++c) {
                sh[(row + 1) * 3 + c] = static_cast<float>(value[c]);
            }
        }
    }

private:
    std::array<std::array<float, 15>, 15> factors_ {};
};
} // namespace splat_transform::spatial
