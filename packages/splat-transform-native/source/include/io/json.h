#pragma once
#include <Eigen/Geometry>
#include <filesystem>
#include <nlohmann/json.hpp>

namespace splat_transform::io {
using Json = nlohmann::ordered_json;

inline Json bounds_json(const Eigen::AlignedBox3f& bounds) {
    return { { "min", { bounds.min().x(), bounds.min().y(), bounds.min().z() } },
        { "max", { bounds.max().x(), bounds.max().y(), bounds.max().z() } } };
}
Json read_json(const std::filesystem::path& path);
} // namespace splat_transform::io
