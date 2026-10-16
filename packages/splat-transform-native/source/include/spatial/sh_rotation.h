#pragma once
#include <cmath>
#include <splat/splat.h>
#include <stdexcept>
#include <unsupported/Eigen/KroneckerProduct>

// ShCoefficients rotation factors ported from the existing implementation.
// Original formulas: https://github.com/andrewwillmott/sh-lib
namespace splat_transform::spatial {
class ShRotation {
public:
    explicit ShRotation(const Eigen::Matrix3f& rotation) {
        // First-order basis: (x, y, z) -> (y, -z, x).
        static const Eigen::Matrix3f basis { { 0, 1, 0 }, { 0, 0, -1 }, { 1, 0, 0 } };
        // Flatten tensor indices as a * dimension + b. These fixed maps retain
        // the signs, coefficient order and scalar polynomials of the original basis.
        static const Eigen::Matrix<float, 5, 9> projection2 = [] {
            const float h = std::sqrt(0.5f), q = std::sqrt(1.0f / 6);
            return Eigen::Matrix<float, 5, 9> {
                { 0, 0, h, 0, 0, 0, h, 0, 0 },
                { 0, h, 0, h, 0, 0, 0, 0, 0 },
                { -q, 0, 0, 0, 2 * q, 0, 0, 0, -q },
                { 0, 0, 0, 0, 0, h, 0, h, 0 },
                { -h, 0, 0, 0, 0, 0, 0, 0, h }
            };
        }();
        static const Eigen::Matrix<float, 9, 5> embedding2 = [] {
            const float h = std::sqrt(0.5f), q = std::sqrt(3.0f / 2);
            // Keep the original middle-column z^2 embedding; subtracting its
            // trace would only be equivalent for exactly orthogonal input matrices.
            return Eigen::Matrix<float, 9, 5> {
                { 0, 0, 0, 0, -h },
                { 0, h, 0, 0, 0 },
                { h, 0, 0, 0, 0 },
                { 0, h, 0, 0, 0 },
                { 0, 0, q, 0, 0 },
                { 0, 0, 0, h, 0 },
                { h, 0, 0, 0, 0 },
                { 0, 0, 0, h, 0 },
                { 0, 0, 0, 0, h }
            };
        }();
        static const Eigen::Matrix<float, 7, 15> projection3 = [] {
            Eigen::Matrix<float, 7, 15> result = Eigen::Matrix<float, 7, 15>::Zero();
            const float q = std::sqrt(1.0f / 6), a = std::sqrt(1.0f / 5), b = std::sqrt(1.0f / 60);
            const float c = std::sqrt(4.0f / 15), d = std::sqrt(1.0f / 10), e = std::sqrt(3.0f / 10);
            result(0, 4) = result(0, 10) = 0.5f;
            result(1, 3) = result(1, 5) = result(1, 11) = q;
            result(2, 2) = a;
            result(2, 4) = b;
            result(2, 6) = c;
            result(2, 10) = -b;
            result(3, 1) = result(3, 13) = -d;
            result(3, 7) = e;
            result(4, 0) = result(4, 14) = -b;
            result(4, 8) = c;
            result(4, 12) = a;
            result(5, 1) = -q;
            result(5, 9) = result(5, 13) = q;
            result(6, 0) = -0.5f;
            result(6, 14) = 0.5f;
            return result;
        }();
        static const Eigen::Matrix<float, 15, 7> embedding3 = [] {
            Eigen::Matrix<float, 15, 7> result = Eigen::Matrix<float, 15, 7>::Zero();
            result(0, 6) = -1;
            result(4, 0) = result(10, 0) = result(14, 6) = 1;
            result(5, 1) = result(9, 5) = std::sqrt(6.0f);
            result(6, 2) = result(8, 4) = std::sqrt(15.0f) / 2;
            result(7, 3) = std::sqrt(10.0f / 3);
            return result;
        }();
        sh1_.noalias() = basis * rotation * basis.transpose();
        sh2_.noalias() = projection2 * Eigen::kroneckerProduct(sh1_, sh1_).eval() * embedding2;
        sh3_.noalias() = projection3 * Eigen::kroneckerProduct(sh1_, sh2_).eval() * embedding3;
    }
    void apply(splat::ShCoefficients& sh) const {
        const size_t count = sh.size() > 3 ? (sh.size() - 3) / 3 : 0;
        if (count == 0) {
            return;
        }
        if (count != 3 && count != 8 && count != 15) {
            throw std::runtime_error("Unsupported SH coefficient count");
        }
        if (!Eigen::Map<const Eigen::VectorXf>(sh.data() + 3, count * 3).allFinite()) {
            // The former dense product also propagated 0 * NaN/Inf across bands.
            Eigen::Matrix<float, 15, 15> factors = Eigen::Matrix<float, 15, 15>::Zero();
            factors.topLeftCorner<3, 3>() = sh1_;
            factors.block<5, 5>(3, 3) = sh2_;
            factors.bottomRightCorner<7, 7>() = sh3_;
            Eigen::Map<Eigen::Matrix<float, Eigen::Dynamic, 3, Eigen::RowMajor>> coefficients(sh.data() + 3, count, 3);
            coefficients = (factors.topLeftCorner(count, count) * coefficients).eval();
            return;
        }
        rotate_band<3>(sh, 1, sh1_);
        if (count >= 8) {
            rotate_band<5>(sh, 4, sh2_);
        }
        if (count == 15) {
            rotate_band<7>(sh, 9, sh3_);
        }
    }

private:
    template<int Size>
    static void rotate_band(splat::ShCoefficients& sh, size_t offset, const Eigen::Matrix<float, Size, Size>& rotation) {
        // Rows are coefficients, columns are RGB. Evaluate before overwriting input.
        Eigen::Map<Eigen::Matrix<float, Size, 3, Eigen::RowMajor>> coefficients(sh.data() + offset * 3);
        coefficients = (rotation * coefficients).eval();
    }
    Eigen::Matrix3f sh1_;
    Eigen::Matrix<float, 5, 5> sh2_;
    Eigen::Matrix<float, 7, 7> sh3_;
};
} // namespace splat_transform::spatial
