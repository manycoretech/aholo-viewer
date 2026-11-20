#include "../data_support.h"
#include <algorithm>
#include <array>
#include <pipeline/tasks/filter.h>
#include <utility/logger.h>
#include <utility/parallel.h>
#include <utility/string.h>
#include <voxel/voxelize.h>

namespace splat_transform::pipeline {
namespace {
using io::Json;
enum class FilterMode { Box,
    Sphere,
    Cluster,
    Floaters };
constexpr std::array<std::string_view, 4> names { "box", "sphere", "cluster", "floaters" };

FilterMode filter_mode(const Json& config) {
    const auto& value = config.at("mode");
    if (value.is_string()) {
        const auto name = utility::lower(value.get<std::string>());
        const auto found = std::ranges::find(names, name);
        if (found != names.end()) {
            return static_cast<FilterMode>(found - names.begin());
        }
    } else if (value.is_number()) {
        const auto index = unsigned_integer(value, "Filter mode");
        if (index < names.size()) {
            return static_cast<FilterMode>(index);
        }
    }
    throw std::runtime_error("Filter mode must be box, sphere, cluster, floaters, or 0 through 3");
}
const Json& options(const Json& config, FilterMode p) {
    static const Json empty = Json::object();
    auto found = config.find(names[static_cast<size_t>(p)]);
    if (found == config.end() || found->is_null()) {
        return empty;
    }
    if (!found->is_object()) {
        return empty;
    }
    return *found;
}
voxel::GridSpec grid_spec(FilterMode p, const Json& obj) {
    const bool cluster = p == FilterMode::Cluster;
    const float resolution = obj.value("voxelResolution", cluster ? 1.0f : 0.05f);
    const float opacity = obj.value("opacityCutoff", cluster ? 0.999f : 0.1f);
    return { resolution, opacity };
}
} // namespace

void FilterTask::exec(const Json& config, TaskContext& context) const {
    const auto p = filter_mode(config);
    const auto& obj = options(config, p);
    const auto& source = plain_splat(context.input(config));
    const auto count = source.size();
    if ((p == FilterMode::Box && (!obj.contains("min") || !obj.contains("max"))) ||
        (p == FilterMode::Sphere && (!obj.contains("center") || !obj.contains("radius")))) {
        context.set(config, context.input(config));
        utility::logger().info("Filter ", names[static_cast<size_t>(p)], ": missing region parameters, passing input through");
        return;
    }
    std::vector<uint32_t> selected;
    if (p == FilterMode::Box) {
        const Eigen::AlignedBox3f box { read_vector3(obj.at("min")), read_vector3(obj.at("max")) };
        selected = threading::select_indices(count, [&](size_t i) {
            return box.contains(source.gaussians[i].mean);
        });
    } else if (p == FilterMode::Sphere) {
        const Eigen::Vector3f center = read_vector3(obj.at("center"));
        const float radius = obj.at("radius").get<float>();
        const float radius_squared = radius * radius;
        selected = threading::select_indices(count, [&](size_t i) {
            return (source.gaussians[i].mean - center).squaredNorm() < radius_squared;
        });
    } else {
        const bool cluster = p == FilterMode::Cluster;
        const auto spec = grid_spec(p, obj);
        const float min_contribution = obj.value("minContribution", cluster ? 0.1f : 0.004f);
        if (count) {
            auto grid = context.find_grid(config, spec);
            const bool reused = grid != nullptr;
            if (!grid) {
                grid = &context.store_grid(config, voxel::generate_occupancy(source, spec));
            }
            utility::logger().info("Filter ", reused ? "reusing" : "generating", " occupancy: voxelResolution=", grid->spec.voxel_resolution,
                ", requested=", spec.voxel_resolution, ", opacityCutoff=", grid->spec.opacity_cutoff);
            selected = voxel::filter_indices(source, *grid, min_contribution, cluster);
        }
    }
    auto result = std::make_shared<splat::Splat>(context.select_splat(config, selected));
    single_block(*result);
    context.set(config, std::move(result));
    utility::logger().info("Filter ", names[static_cast<size_t>(p)], ": kept ", selected.size(), " / ", count, " Gaussians");
}
} // namespace splat_transform::pipeline
