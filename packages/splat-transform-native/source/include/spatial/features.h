#pragma once
#include <splat/splat.h>

namespace splat_transform::spatial {
using FeatureMatrix = Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>;

// Borrow native SH records without copying their coefficient storage.
// The feature permutation preserves the existing clustering arithmetic order.
class FeatureView {
public:
    explicit FeatureView(const splat::Splat& points) : gaussians_(points.gaussians), dimensions_(points.sh_count()) {
        const auto coefficients = dimensions_ / 3;
        for (size_t c = 0; c < 3; ++c) {
            for (size_t j = 0; j < coefficients; ++j) {
                attributes_[c * coefficients + j] = static_cast<uint8_t>(3 + j * 3 + c);
            }
        }
    }
    FeatureView(splat::Splat&&) = delete;
    FeatureView(const splat::Splat&&) = delete;
    size_t rows() const noexcept { return gaussians_.size(); }
    size_t dimensions() const noexcept { return dimensions_; }
    const float& operator()(size_t row, size_t feature) const {
        return gaussians_[row].sh[attributes_[feature]];
    }

private:
    std::span<const splat::Gaussian> gaussians_;
    size_t dimensions_;
    std::array<uint8_t, 45> attributes_ {};
};
} // namespace splat_transform::spatial
