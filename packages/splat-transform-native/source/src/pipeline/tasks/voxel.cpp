#include "../data_support.h"
#include <pipeline/tasks/voxel.h>
#include <utility/logger.h>
#include <voxel/grid.h>
namespace splat_transform::pipeline {
using io::Json;
namespace {
voxel::BackendType backend_type(const Json& config) {
    const auto name = config.value("backend", std::string("gpu"));
    if (name == "cpu") {
        return voxel::BackendType::Cpu;
    }
    if (name == "gpu") {
        return voxel::BackendType::Gpu;
    }
    throw std::runtime_error("Voxel backend must be cpu or gpu");
}
voxel::Options voxel_options(const Json& config) {
    voxel::Options options;
    options.backend = backend_type(config);
    const auto compression = config.value("compression", std::string("none"));
    if (compression == "gzip") {
        options.compression = voxel::Compression::Gzip;
    } else if (compression == "zstd") {
        options.compression = voxel::Compression::Zstd;
    } else if (compression != "none") {
        throw std::runtime_error("Invalid voxel compression");
    }
    const auto encoding = config.value("nodeEncoding", std::string("raw"));
    if (encoding == "compact") {
        options.node_encoding = voxel::NodeEncoding::Compact;
    } else if (encoding != "raw") {
        throw std::runtime_error("Invalid voxel nodeEncoding");
    }
    const auto shape = config.value("collisionMesh", Json(false));
    if (shape == true || shape == "smooth") {
        options.collision_mesh = voxel::CollisionMesh::Smooth;
    } else if (shape == "faces") {
        options.collision_mesh = voxel::CollisionMesh::Faces;
    } else if (shape != false) {
        throw std::runtime_error("collisionMesh must be true, false, faces, or smooth");
    }
    options.voxel_resolution = config.value("voxelResolution", options.voxel_resolution);
    options.opacity_cutoff = config.value("opacityCutoff", options.opacity_cutoff);
    if (config.contains("box")) {
        const auto& box = config.at("box");
        options.box = { read_vector3(box.at("minCorner")), read_vector3(box.at("maxCorner")) };
    }
    const auto automatic = config.value("autoDenseBox", Json(true));
    if (automatic == false) {
        options.auto_dense_box.reset();
    } else if (automatic.is_object()) {
        auto& dense = *options.auto_dense_box;
        dense.minimum_axis_inflation = automatic.value("minimumAxisInflation", dense.minimum_axis_inflation);
        dense.minimum_volume_inflation = automatic.value("minimumVolumeInflation", dense.minimum_volume_inflation);
        dense.target_center_keep_ratio = automatic.value("targetCenterKeepRatio", dense.target_center_keep_ratio);
        dense.minimum_center_keep_ratio = automatic.value("minimumCenterKeepRatio", dense.minimum_center_keep_ratio);
    }
    const auto filter = config.value("filterCluster", Json(true));
    if (filter == false) {
        options.filter_cluster.reset();
    } else if (filter.is_object()) {
        auto& cluster = *options.filter_cluster;
        cluster.voxel_resolution = filter.value("voxelResolution", cluster.voxel_resolution);
        cluster.opacity_cutoff = filter.value("opacityCutoff", cluster.opacity_cutoff);
        cluster.min_contribution = filter.value("minContribution", cluster.min_contribution);
        if (filter.contains("seed")) {
            cluster.seed = read_vector3(filter.at("seed"));
        }
    }
    auto& navigation = options.navigation;
    navigation.floor_fill = config.value("floorFill", navigation.floor_fill);
    navigation.floor_dilation = config.value("floorFillDilation", navigation.floor_dilation);
    navigation.exterior_radius = config.value("navExteriorRadius", navigation.exterior_radius);
    if (config.contains("navSeed")) {
        navigation.seed = read_vector3(config.at("navSeed"));
    }
    if (config.contains("navCapsule")) {
        navigation.capsule_height = config.at("navCapsule").at("height").get<float>();
        navigation.capsule_radius = config.at("navCapsule").at("radius").get<float>();
    }
    return options;
}
} // namespace
bool VoxelTask::requires_gpu(const Json& config, const TaskContext&) const {
    return voxel::requires_gpu(backend_type(config));
}
void VoxelTask::exec(const Json& config, TaskContext& context) const {
    const auto& data = *context.splat_ptr(config);
    const auto output = context.paths.resolve(config.at("output").get<std::string>());
    auto& logger = utility::logger();
    logger.info("writing voxel -> dir=\"", output.string(), "\" count=", data.size(), " SH=", data.sh_degree);
    voxel::write(data, output, voxel_options(config), [&](voxel::Occupancy&& grid) {
        context.store_grid(config, std::move(grid));
    });
    context.record_voxel(config);
    logger.info("voxelizing done");
}
} // namespace splat_transform::pipeline
