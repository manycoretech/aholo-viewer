#include "data_support.h"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <optional>
#include <pipeline/runner.h>
#include <spatial/sh_rotation.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
namespace {
Eigen::Matrix4f matrix(const io::Json& value, bool row_major) {
    Eigen::Matrix4f result = Eigen::Matrix4f::Identity();
    if (value.is_null()) {
        return result;
    }
    if (!value.is_array() || value.size() != 16) {
        throw std::runtime_error("Transform must contain 16 numbers");
    }
    for (size_t row = 0; row < 4; ++row) {
        for (size_t column = 0; column < 4; ++column) {
            result(row, column) = value.at(row_major ? row * 4 + column : column * 4 + row).get<float>();
        }
    }
    return result;
}
std::pair<bool, bool> transform(splat::Splat& data, std::span<const uint32_t> indices, const Eigen::Matrix4f& matrix) {
    if (matrix == Eigen::Matrix4f::Identity()) {
        return { false, false };
    }
    Eigen::Vector3f scale;
    for (int c = 0; c < 3; ++c) {
        scale[c] = matrix.block<3, 1>(0, c).norm();
    }
    if (matrix.determinant() < 0) {
        scale.x() = -scale.x();
    }
    if ((scale.array() == 0).any()) {
        throw std::runtime_error("Singular splat transform");
    }
    Eigen::Matrix3f rotation;
    for (int c = 0; c < 3; ++c) {
        rotation.col(c) = matrix.block<3, 1>(0, c) / scale[c];
    }
    const Eigen::Quaternionf quaternion(rotation);
    spatial::ShRotation sh_rotation(quaternion.toRotationMatrix());
    const bool rotate = quaternion.coeffs() != Eigen::Quaternionf::Identity().coeffs();
    const bool resize = scale != Eigen::Vector3f::Ones();
    for (auto index : indices) {
        if (index >= data.size()) {
            throw std::runtime_error("Transform splat index out of range");
        }
        auto& gaussian = data.gaussians[index];
        const Eigen::Vector4f center = matrix * gaussian.mean.homogeneous();
        gaussian.mean = center.head<3>() / center.w();
        if (resize) {
            gaussian.scale.array() *= scale.array();
        }
        if (rotate) {
            gaussian.rotation = (quaternion * gaussian.rotation).normalized();
            sh_rotation.apply(gaussian.sh);
        }
    }
    return { resize, rotate };
}
} // namespace
void modify(splat::Splat& data, const io::Json& config) {
    std::optional<std::array<float, 4>> rgba;
    std::optional<unsigned> max_sh_degree;
    if (config.contains("rgba")) {
        const auto& value = config.at("rgba");
        if (!value.is_array() || value.size() != 4) {
            throw std::runtime_error("Modify rgba must contain four finite float values");
        }
        rgba.emplace();
        for (size_t i = 0; i < 4; ++i) {
            if (!value[i].is_number()) {
                throw std::runtime_error("Modify rgba must contain four finite float values");
            }
            // Validate the JSON number before narrowing to the attribute's float representation.
            const auto number = value[i].get<double>();
            if (!std::isfinite(number) || std::abs(number) > std::numeric_limits<float>::max()) {
                throw std::runtime_error("Modify rgba value is outside the finite float range");
            }
            (*rgba)[i] = static_cast<float>(number);
            if (number != 0 && (*rgba)[i] == 0) {
                throw std::runtime_error("Modify rgba value underflows the float range");
            }
        }
    }
    if (config.contains("maxShDegree")) {
        max_sh_degree = unsigned_integer(config.at("maxShDegree"), "maxShDegree");
        if (*max_sh_degree > 3) {
            throw std::runtime_error("Modify maxShDegree must be 0, 1, 2, or 3");
        }
    }
    auto& logger = utility::logger();
    const auto paths = config.value("modifyPaths", std::vector<std::string>());
    if (paths.size() > data.block_counts.size()) {
        throw std::runtime_error("More modify files than input blocks");
    }
    std::vector<bool> deleted(data.size(), false);
    for (size_t block = 0; block < paths.size(); ++block) {
        if (paths[block].empty()) {
            logger.info("modify[", block, "] is null, skip");
            continue;
        }
        const auto spec = io::read_json(io::utf8_path(paths[block]));
        const bool row_major = spec.value("isRowMatrix", true);
        const auto model = matrix(spec.value("transform", io::Json()), row_major);
        const size_t offset = data.block_offsets[block], count = data.block_counts[block];
        std::vector<bool> used(count, false);
        const auto bitmap = spec.value("deletedIndices", std::vector<uint8_t>());
        size_t deleted_count = 0;
        for (size_t i = 0; i < bitmap.size(); ++i) {
            for (size_t bit = 0; bit < 8; ++bit) {
                const size_t index = i * 8 + bit;
                if (index < count && (bitmap[i] & (1u << bit))) {
                    used[index] = true;
                    deleted[offset + index] = true;
                    ++deleted_count;
                }
            }
        }
        const auto groups = spec.value("indicesTransform", io::Json::array());
        logger.info("modify[", block, "] offset=", offset, " groups=", groups.size(), " delete=", deleted_count);
        size_t group_index = 0;
        for (const auto& group : groups) {
            std::vector<uint32_t> indices;
            for (const auto& item : group.at("indices")) {
                const auto index = item.get<size_t>();
                if (index >= count) {
                    throw std::runtime_error("Modify index exceeds input block");
                }
                used[index] = true;
                indices.push_back(static_cast<uint32_t>(offset + index));
            }
            const Eigen::Matrix4f combined = matrix(group.at("transform"), row_major) * model;
            const auto [scale, rotate] = transform(data, indices, combined);
            logger.info("group[", block, ':', group_index++, "] size=", indices.size(), " scale=", scale, " rotate=", rotate);
        }
        std::vector<uint32_t> remaining;
        for (size_t i = 0; i < count; ++i) {
            if (!used[i]) {
                remaining.push_back(static_cast<uint32_t>(offset + i));
            }
        }
        transform(data, remaining, model);
    }
    if (std::any_of(deleted.begin(), deleted.end(), [](bool value) { return value; })) {
        std::vector<uint32_t> remaining;
        for (size_t i = 0; i < data.size(); ++i) {
            if (!deleted[i]) {
                remaining.push_back(static_cast<uint32_t>(i));
            }
        }
        auto offsets = data.block_offsets;
        auto counts = data.block_counts;
        // Rebase each block onto the compacted sequence, retaining empty block slots.
        for (size_t block = 0; block < counts.size(); ++block) {
            const auto first = std::lower_bound(remaining.begin(), remaining.end(), offsets[block]);
            const auto last = std::lower_bound(first, remaining.end(), offsets[block] + counts[block]);
            offsets[block] = static_cast<size_t>(first - remaining.begin());
            counts[block] = static_cast<size_t>(last - first);
        }
        logger.info("delete ", data.size() - remaining.size(), " splat");
        data = std::move(data).select(remaining);
        data.block_offsets = std::move(offsets);
        data.block_counts = std::move(counts);
    }
    if (rgba) {
        for (auto& gaussian : data.gaussians) {
            for (size_t i = 0; i < 4; ++i) {
                gaussian.attribute(splat::Red + i) = (*rgba)[i];
            }
        }
    }
    if (max_sh_degree) {
        data.limit_sh_degree(*max_sh_degree);
    }
}
} // namespace splat_transform::pipeline
