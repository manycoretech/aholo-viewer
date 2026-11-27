#pragma once
#include <cmath>
#include <cstdint>
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
                { 0, 0, h, 0, 0, 0, h, 0, 0 }, { 0, h, 0, h, 0, 0, 0, 0, 0 },
                { -q, 0, 0, 0, 2 * q, 0, 0, 0, -q }, { 0, 0, 0, 0, 0, h, 0, h, 0 },
                { -h, 0, 0, 0, 0, 0, 0, 0, h }
            };
        }();
        static const Eigen::Matrix<float, 9, 5> embedding2 = [] {
            const float h = std::sqrt(0.5f), q = std::sqrt(3.0f / 2);
            // Keep the original middle-column z^2 embedding; subtracting its
            // trace would only be equivalent for exactly orthogonal input matrices.
            return Eigen::Matrix<float, 9, 5> {
                { 0, 0, 0, 0, -h }, { 0, h, 0, 0, 0 }, { h, 0, 0, 0, 0 },
                { 0, h, 0, 0, 0 }, { 0, 0, q, 0, 0 }, { 0, 0, 0, h, 0 },
                { h, 0, 0, 0, 0 }, { 0, 0, 0, h, 0 }, { 0, 0, 0, 0, h }
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
        this->sh1_.noalias() = basis * rotation * basis.transpose();
        this->sh2_.noalias() = projection2 * Eigen::kroneckerProduct(this->sh1_, this->sh1_).eval() * embedding2;
        this->sh3_.noalias() = projection3 * Eigen::kroneckerProduct(this->sh1_, this->sh2_).eval() * embedding3;
        // Orthonormal real Clebsch-Gordan projection from bands 1 x 3 onto band 4.
        // Rows are m=-4..4. Columns are (m1+1)*7 + (m3+3), in the same basis as sh1_ and sh3_.
        static const Eigen::Matrix<float, 9, 21> projection4 = [] {
            Eigen::Matrix<float, 9, 21> p = Eigen::Matrix<float, 9, 21>::Zero();
            const auto weight = [](float numerator) { return std::sqrt(numerator / 56.0f); };
            p(0, 6) = p(0, 14) = weight(28);
            p(1, 5) = p(1, 15) = weight(21);
            p(1, 7) = 0.5f;
            p(2, 4) = p(2, 16) = weight(15);
            p(2, 6) = weight(1);
            p(2, 8) = weight(24);
            p(2, 14) = -weight(1);
            p(3, 3) = weight(20);
            p(3, 5) = weight(3);
            p(3, 9) = weight(30);
            p(3, 15) = -weight(3);
            p(4, 2) = p(4, 18) = -weight(12);
            p(4, 10) = weight(32);
            p(5, 1) = p(5, 19) = -weight(3);
            p(5, 11) = weight(30);
            p(5, 17) = weight(20);
            p(6, 0) = p(6, 20) = -weight(1);
            p(6, 2) = -weight(15);
            p(6, 12) = weight(24);
            p(6, 18) = weight(15);
            p(7, 1) = -weight(21);
            p(7, 13) = 0.5f;
            p(7, 19) = weight(21);
            p(8, 0) = -weight(28);
            p(8, 20) = weight(28);
            return p;
        }();
        this->sh4_.noalias() =
            projection4 * Eigen::kroneckerProduct(this->sh1_, this->sh3_).eval() * projection4.transpose();
    }
    void apply(splat::ShCoefficients& sh) const {
        const size_t count = sh.size() > 3 ? (sh.size() - 3) / 3 : 0;
        if (count == 0) {
            return;
        }
        if (count != 3 && count != 8 && count != 15 && count != 24) {
            throw std::runtime_error("Unsupported SH coefficient count");
        }
        if (!Eigen::Map<const Eigen::VectorXf>(sh.data() + 3, count * 3).allFinite()) {
            // The former dense product also propagated 0 * NaN/Inf across bands.
            Eigen::Matrix<float, 24, 24> factors = Eigen::Matrix<float, 24, 24>::Zero();
            factors.topLeftCorner<3, 3>() = this->sh1_;
            factors.block<5, 5>(3, 3) = this->sh2_;
            factors.block<7, 7>(8, 8) = this->sh3_;
            factors.bottomRightCorner<9, 9>() = this->sh4_;
            Eigen::Map<Eigen::Matrix<float, Eigen::Dynamic, 3, Eigen::RowMajor>> coefficients(sh.data() + 3, count, 3);
            coefficients = (factors.topLeftCorner(count, count) * coefficients).eval();
            return;
        }
        rotate_band<3>(sh, 1, this->sh1_);
        if (count >= 8) {
            rotate_band<5>(sh, 4, this->sh2_);
        }
        if (count >= 15) {
            rotate_band<7>(sh, 9, this->sh3_);
        }
        if (count == 24) {
            rotate_band<9>(sh, 16, this->sh4_);
        }
    }

private:
    template<int32_t Size>
    static void rotate_band(
        splat::ShCoefficients& sh, size_t offset, const Eigen::Matrix<float, Size, Size>& rotation
    ) {
        // Rows are coefficients, columns are RGB. Evaluate before overwriting input.
        Eigen::Map<Eigen::Matrix<float, Size, 3, Eigen::RowMajor>> coefficients(sh.data() + offset * 3);
        coefficients = (rotation * coefficients).eval();
    }
    Eigen::Matrix3f sh1_;
    Eigen::Matrix<float, 5, 5> sh2_;
    Eigen::Matrix<float, 7, 7> sh3_;
    Eigen::Matrix<float, 9, 9> sh4_;
};
} // namespace splat_transform::spatial
