#pragma once
#include <algorithm>
#include <splat/splat.h>

namespace splat_transform::spatial {

// Borrow native SH records without copying their coefficient storage.
// The feature permutation preserves the existing clustering arithmetic order.
class FeatureView {
public:
    explicit FeatureView(const splat::Splat& points, uint32_t max_sh_degree = splat::MAX_SH_DEGREE)
        : gaussians_(points.gaussians), dimensions_(splat::SH_COUNTS.at(std::min(points.sh_degree, max_sh_degree))) {
        const auto coefficients = this->dimensions_ / 3;
        for (size_t c = 0; c < 3; ++c) {
            for (size_t j = 0; j < coefficients; ++j) {
                this->attributes_[c * coefficients + j] = static_cast<uint8_t>(3 + j * 3 + c);
            }
        }
    }
    FeatureView(const splat::Splat&&, uint32_t = splat::MAX_SH_DEGREE) = delete;
    size_t rows() const noexcept { return this->gaussians_.size(); }
    size_t dimensions() const noexcept { return this->dimensions_; }
    const float& operator()(size_t row, size_t feature) const {
        return this->gaussians_[row].sh[this->attributes_[feature]];
    }

private:
    std::span<const splat::Gaussian> gaussians_;
    size_t dimensions_;
    std::array<uint8_t, splat::SH_COUNTS.back()> attributes_ {};
};
} // namespace splat_transform::spatial
