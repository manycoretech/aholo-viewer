#pragma once
#include <filesystem>
#include <optional>
#include <splat/splat.h>

namespace splat_transform::voxel {
enum class BackendType {
    Cpu,
    Gpu,
};
enum class Compression {
    None,
    Gzip,
    Zstd,
};
enum class NodeEncoding {
    Raw,
    Compact,
};
enum class CollisionMesh {
    None,
    Faces,
    Smooth,
};

struct DenseBoxOptions {
    float minimum_axis_inflation = 1.5f;
    float minimum_volume_inflation = 4;
    float target_center_keep_ratio = 0.98f;
    float minimum_center_keep_ratio = 0.95f;
};
struct FilterClusterOptions {
    float voxel_resolution = 1;
    float opacity_cutoff = 0.999f;
    float min_contribution = 0.1f;
    std::optional<Eigen::Vector3f> seed;
};
struct Navigation {
    bool floor_fill = false;
    float floor_dilation = 0;
    float exterior_radius = 0;
    float capsule_height = 0;
    float capsule_radius = 0;
    std::optional<Eigen::Vector3f> seed;
};
struct Options {
    BackendType backend = BackendType::Gpu;
    Compression compression = Compression::None;
    NodeEncoding node_encoding = NodeEncoding::Raw;
    CollisionMesh collision_mesh = CollisionMesh::None;
    float voxel_resolution = 0.05f;
    float opacity_cutoff = 0.1f;
    Eigen::AlignedBox3f box { Eigen::Vector3f::Constant(-100), Eigen::Vector3f::Constant(100) };
    // No value disables the corresponding optional processing phase.
    std::optional<DenseBoxOptions> auto_dense_box = DenseBoxOptions {};
    std::optional<FilterClusterOptions> filter_cluster = FilterClusterOptions {};
    Navigation navigation;
};

bool requires_gpu(BackendType backend);
void write(const splat::Splat& data, const std::filesystem::path& directory, const Options& options = {});
} // namespace splat_transform::voxel
