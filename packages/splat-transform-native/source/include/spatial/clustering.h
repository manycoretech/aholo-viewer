#pragma once
#include <array>
#include <concepts>
#include <cstdint>
#include <functional>
#include <span>
#include <spatial/features.h>
#include <splat/attribute_view.h>
#include <type_traits>
#include <utility>
#include <vector>

namespace splat_transform::spatial {
struct Quantization {
    std::array<float, 256> centroids {};
    Eigen::Matrix<uint8_t, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> labels;
};
struct Clustering {
    FeatureMatrix centroids;
    std::vector<uint32_t> labels;
};
namespace detail {
Quantization quantize_values(std::vector<float> values, size_t rows, size_t columns);
}

template<typename Transform>
concept QuantizationTransform = std::invocable<Transform&, const float&> &&
                                std::convertible_to<std::invoke_result_t<Transform&, const float&>, float>;

template<QuantizationTransform Transform = std::identity>
Quantization quantize_1d(std::span<const splat::AttributeView> fields, Transform&& transform = {}) {
    const size_t rows = fields.empty() ? 0 : fields.front().size();
    std::vector<float> values;
    values.reserve(rows * fields.size());
    for (const auto& field : fields) {
        for (size_t i = 0; i < field.size(); ++i) {
            values.push_back(static_cast<float>(std::invoke(transform, field[i])));
        }
    }
    return detail::quantize_values(std::move(values), rows, fields.size());
}

template<QuantizationTransform Transform = std::identity>
Quantization quantize_1d(const FeatureMatrix& fields, Transform&& transform = {}) {
    std::vector<splat::AttributeView> attributes;
    attributes.reserve(static_cast<size_t>(fields.cols()));
    const std::span values(fields.data(), static_cast<size_t>(fields.size()));
    for (Eigen::Index c = 0; c < fields.cols(); ++c) {
        attributes.emplace_back(values.empty() ? values : values.subspan(static_cast<size_t>(c)), static_cast<size_t>(fields.cols()));
    }
    return quantize_1d(attributes, std::forward<Transform>(transform));
}

Clustering k_means(FeatureView points, size_t count, size_t iterations = 10);
} // namespace splat_transform::spatial
