#pragma once
#include <splat/splat.h>
#include <stdexcept>

namespace splat_transform::splat {
// Borrow one scalar attribute without creating a column-oriented copy of a cloud.
class AttributeView {
public:
    explicit AttributeView(std::span<const float> values, size_t stride = 1) : values_(values), stride_(stride) {
        if (!stride) {
            throw std::invalid_argument("Attribute stride must be positive");
        }
        size_ = values.empty() ? 0 : 1 + (values.size() - 1) / stride;
    }
    AttributeView(const Splat& splat, size_t attribute) : gaussians_(splat.gaussians), size_(splat.size()), attribute_(attribute) {}
    AttributeView(Splat&&, size_t) = delete;
    size_t size() const noexcept { return size_; }
    const float& operator[](size_t index) const {
        return gaussians_.empty() ? values_[index * stride_] : gaussians_[index].attribute(attribute_);
    }

private:
    std::span<const float> values_;
    std::span<const Gaussian> gaussians_;
    size_t size_;
    size_t attribute_ = 0;
    size_t stride_ = 1;
};
} // namespace splat_transform::splat
