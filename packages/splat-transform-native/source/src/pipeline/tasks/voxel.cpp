#include <pipeline/tasks/voxel.h>
#include <utility/logger.h>
#include <voxel/voxel.h>
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
Eigen::Vector3f vector3(const Json& value) {
    return { value.at("x").get<float>(), value.at("y").get<float>(), value.at("z").get<float>() };
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
        const auto minimum = config.at("box").at("minCorner").get<std::array<float, 3>>();
        const auto maximum = config.at("box").at("maxCorner").get<std::array<float, 3>>();
        options.box = { Eigen::Map<const Eigen::Vector3f>(minimum.data()), Eigen::Map<const Eigen::Vector3f>(maximum.data()) };
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
            cluster.seed = vector3(filter.at("seed"));
        }
    }
    auto& navigation = options.navigation;
    navigation.floor_fill = config.value("floorFill", navigation.floor_fill);
    navigation.floor_dilation = config.value("floorFillDilation", navigation.floor_dilation);
    navigation.exterior_radius = config.value("navExteriorRadius", navigation.exterior_radius);
    if (config.contains("navSeed")) {
        navigation.seed = vector3(config.at("navSeed"));
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
    const auto output = io::utf8_path(config.at("output").get<std::string>());
    auto& logger = utility::logger();
    logger.info("writing voxel -> dir=\"", io::path_utf8(output), "\" count=", data.size(), " SH=", data.sh_degree);
    voxel::write(data, output, voxel_options(config));
    context.record_voxel(config);
    logger.info("voxelizing done");
}
} // namespace splat_transform::pipeline
