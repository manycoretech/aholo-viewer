#include "voxelize.h"
#include <cmath>
#include <codec/codec.h>
#include <deque>
#include <map>
#include <utility/logger.h>
#include <voxel/voxel.h>

namespace splat_transform::voxel {
namespace {
struct Octree {
    uint32_t depth = 1;
    uint32_t interiors = 0;
    uint32_t mixed = 0;
    std::vector<uint32_t> nodes;
    std::vector<uint32_t> leaves;
};
class OctreeOverflow : public std::runtime_error {
public:
    uint64_t count;
    explicit OctreeOverflow(uint64_t count) : std::runtime_error("Voxel octree exceeds 24-bit offsets"), count(count) {}
};
uint64_t morton(Point p) {
    uint64_t value = 0;
    for (unsigned bit = 0; bit < 21; ++bit) {
        for (unsigned a = 0; a < 3; ++a) {
            value |= uint64_t((p[a] >> bit) & 1) << (3 * bit + a);
        }
    }
    return value;
}
Octree build_octree(const Grid& grid) {
    struct Node {
        uint64_t mask = 0;
        uint8_t children = 0;
        bool solid = false;
    };
    using Level = std::map<uint64_t, Node>;
    Octree output;
    std::vector<Level> levels(1);
    for (auto index : grid.active_blocks()) {
        const auto mask = grid.mask(index);
        levels.front()[morton(grid.block_point(index))] = { mask, 0, mask == FULL_BLOCK };
    }
    if (levels.front().empty()) {
        return output;
    }
    do {
        Level parents;
        for (auto [key, node] : levels.back()) {
            auto& parent = parents[key / 8];
            parent.children |= 1 << (key % 8);
            if (node.solid) {
                parent.mask |= uint64_t { 1 } << (key % 8);
            }
        }
        for (auto& [key, parent] : parents) {
            parent.solid = parent.mask == 255;
        }
        levels.push_back(std::move(parents));
    } while (levels.back().size() != 1 || levels.back().begin()->first != 0);
    output.depth = uint32_t(levels.size() - 1);
    struct Reference {
        size_t level;
        uint64_t key;
    };
    std::deque<Reference> queue { { levels.size() - 1, 0 } };
    while (!queue.empty()) {
        const auto ref = queue.front();
        queue.pop_front();
        const auto node = levels[ref.level].at(ref.key);
        if (node.solid) {
            output.nodes.push_back(0xff000000u);
        } else if (ref.level == 0) {
            if (output.mixed > 0xffffff) {
                throw OctreeOverflow(uint64_t(output.mixed) + 1);
            }
            output.nodes.push_back(output.mixed++);
            output.leaves.push_back(uint32_t(node.mask));
            output.leaves.push_back(uint32_t(node.mask >> 32));
        } else {
            const uint64_t first = output.nodes.size() + queue.size() + 1;
            if (first > 0xffffff) {
                throw OctreeOverflow(first + 1);
            }
            output.nodes.push_back((uint32_t(node.children) << 24) | uint32_t(first));
            ++output.interiors;
            for (int child = 0; child < 8; ++child) {
                if (node.children & (1 << child)) {
                    queue.push_back({ ref.level - 1, ref.key * 8 + child });
                }
            }
        }
    }
    return output;
}
io::Bytes encode_octree(const Octree& tree, bool compact) {
    io::Bytes output;
    if (compact) {
        const uint32_t tag_bytes = uint32_t((tree.nodes.size() + 3) / 4);
        for (uint32_t value : { 0x31424356u, 1u, uint32_t(tree.nodes.size()), tree.interiors, tree.mixed, uint32_t(tree.leaves.size()), tag_bytes, tree.interiors }) {
            io::append(output, value);
        }
        io::Bytes tags(tag_bytes), masks;
        for (size_t i = 0; i < tree.nodes.size(); ++i) {
            const auto node = tree.nodes[i];
            const uint8_t tag = node == 0xff000000u ? 1 : (node >> 24) ? 2
                                                                       : 0;
            tags[i / 4] |= tag << ((i % 4) * 2);
            if (tag == 2) {
                masks.push_back(node >> 24);
            }
        }
        output.insert(output.end(), tags.begin(), tags.end());
        output.insert(output.end(), masks.begin(), masks.end());
        output.resize((output.size() + 3) & ~size_t { 3 }, 0);
    } else {
        for (auto value : tree.nodes) {
            io::append(output, value);
        }
    }
    for (auto value : tree.leaves) {
        io::append(output, value);
    }
    return output;
}
float fallback_resolution(float current, float count, float target) {
    auto align = [](float value) { return std::round(std::ceil((value - 1e-12f) / 0.01f) * 0.01f * 1e6f) / 1e6f; };
    const float next = align(current * std::cbrt(count / target));
    return next > current ? next : align(current + 0.01f);
}
} // namespace
void write(const splat::Splat& input, const std::filesystem::path& directory, const io::Json& config) {
    auto& logger = utility::logger();
    const auto& backend = resolve_backend(config);
    const auto compression = config.value("compression", std::string("none"));
    const auto encoding = config.value("nodeEncoding", std::string("raw"));
    if (compression != "none" && compression != "gzip" && compression != "zstd") {
        throw std::runtime_error("Invalid voxel compression");
    }
    if (encoding != "raw" && encoding != "compact") {
        throw std::runtime_error("Invalid voxel nodeEncoding");
    }
    float resolution = config.value("voxelResolution", 0.05f);
    const auto requested_resolution = resolution;
    const float cutoff = config.value("opacityCutoff", 0.1f);
    if (!(resolution > 0) || !std::isfinite(resolution) || !std::isfinite(cutoff) || cutoff < 0 || cutoff > 1) {
        throw std::runtime_error("Invalid voxel resolution or opacityCutoff");
    }
    // Voxelization needs geometry and opacity only. Retain one packed buffer
    // through bounds resolution and filtering; never clone the source's SH data.
    auto bounds_time = logger.time("Voxel bounding/extents");
    auto prepared = prepare(input);
    bounds_time.finish();
    const auto box = resolve_box(input, prepared.scene, config);
    const auto filter = config.value("filterCluster", io::Json(true));
    if (filter != false) {
        logger.info("voxel filterCluster enabled");
        auto filter_time = logger.time("Filter clusters");
        filter_cluster(prepared, filter.is_object() ? filter : io::Json::object(), box, backend);
    }
    if (!prepared.invalid_extents.empty()) {
        logger.info("voxel: skipped ", prepared.invalid_extents.size(), " gaussians with invalid extent values");
    }
    logger.info("scene extents: (", utility::fixed(prepared.scene.min()[0]), ',', utility::fixed(prepared.scene.min()[1]), ',', utility::fixed(prepared.scene.min()[2]),
        ") - (", utility::fixed(prepared.scene.max()[0]), ',', utility::fixed(prepared.scene.max()[1]), ',', utility::fixed(prepared.scene.max()[2]), ')');
    Navigation navigation;
    navigation.floor_fill = config.value("floorFill", false);
    navigation.floor_dilation = config.value("floorFillDilation", 0.0f);
    navigation.exterior_radius = config.value("navExteriorRadius", 0.0f);
    if (navigation.floor_dilation < 0 || navigation.exterior_radius < 0) {
        throw std::runtime_error("Navigation dilation must be nonnegative");
    }
    if (config.contains("navSeed")) {
        const auto& seed = config.at("navSeed");
        navigation.seed = Eigen::Vector3f { seed.at("x").get<float>(), seed.at("y").get<float>(), seed.at("z").get<float>() };
    }
    if (config.contains("navCapsule")) {
        navigation.capsule_height = config.at("navCapsule").at("height");
        navigation.capsule_radius = config.at("navCapsule").at("radius");
    }
    const bool has_exterior = navigation.exterior_radius != 0 && navigation.seed.has_value();
    auto resolve_bounds = [&] {
        const float exterior_pad = has_exterior ? (std::ceil(navigation.exterior_radius / resolution) + 1) * resolution : 0;
        const float floor_pad = navigation.floor_fill ? (std::ceil(navigation.floor_dilation / resolution) + 1) * resolution : 0;
        auto bounds = prepared.scene;
        for (int a = 0; a < 3; ++a) {
            const float pad = a == 1 ? exterior_pad : std::max(exterior_pad, floor_pad);
            bounds.min()[a] = std::max(bounds.min()[a] - pad, box.min()[a]);
            bounds.max()[a] = std::min(bounds.max()[a] + pad, box.max()[a]);
            if (!(bounds.min()[a] < bounds.max()[a])) {
                throw std::runtime_error("Voxel box does not overlap scene bounds");
            }
        }
        return align_bounds(bounds, resolution);
    };
    for (int attempt = 0; attempt <= 4; ++attempt) {
        auto bounds = resolve_bounds();
        for (int grid_attempt = 0; grid_attempt < 4; ++grid_attempt) {
            float count = 1;
            for (int a = 0; a < 3; ++a) {
                count *= std::round((bounds.max()[a] - bounds.min()[a]) / (4 * resolution));
            }
            const float target = std::floor(0x7fffffff * 0.55f);
            if (count <= target) {
                break;
            }
            const auto next_resolution = fallback_resolution(resolution, count, target);
            logger.info("voxel resolution fallback: grid blocks total=", count, ", target=", target, "; resolution ", resolution, " -> ", next_resolution);
            resolution = next_resolution;
            bounds = resolve_bounds();
        }
        if (resolution != requested_resolution) {
            logger.info("voxel effective resolution=", resolution, " (requested=", requested_resolution, ')');
        }
        auto voxel_time = logger.time("Voxelizing (" + std::string(backend.name()) + ") done");
        auto grid = backend.voxelize(prepared, bounds, resolution, cutoff);
        voxel_time.finish();
        {
            auto filter_time = logger.time("Filter blocks");
            grid = filter_blocks(grid);
        }
        navigate(grid, bounds, resolution, navigation, backend);
        {
            auto crop_time = logger.time("Crop voxel bounds");
            crop_grid(grid, bounds, resolution, has_exterior || navigation.floor_fill, has_exterior || navigation.floor_fill ? 1 : 0);
        }
        Octree tree;
        try {
            auto tree_time = logger.time("Build octree");
            tree = build_octree(grid);
        } catch (const OctreeOverflow& error) {
            if (attempt == 4) {
                throw;
            }
            const auto next_resolution = fallback_resolution(resolution, float(error.count), std::floor(0x1000000 * 0.98f));
            logger.info("voxel resolution fallback: octree nodes=", error.count, "; resolution ", resolution, " -> ", next_resolution);
            resolution = next_resolution;
            continue;
        }
        logger.info("octree: depth=", tree.depth, ", interior=", tree.interiors, ", mixed=", tree.mixed);
        auto binary = encode_octree(tree, encoding == "compact");
        const auto raw_bytes = binary.size();
        std::string filename = "voxel.bin";
        if (compression == "gzip") {
            binary = codec::gzip(binary);
            filename += ".gz";
        }
        if (compression == "zstd") {
            binary = codec::zstd_compress(binary, 12);
            filename += ".zst";
        }
        const io::Json metadata {
            { "version", "1.2" }, { "gridBounds", io::bounds_json(bounds) },
            { "sceneBounds", io::bounds_json(prepared.scene) },
            { "voxelResolution", resolution }, { "leafSize", 4 }, { "treeDepth", tree.depth },
            { "numInteriorNodes", tree.interiors }, { "numMixedLeaves", tree.mixed },
            { "nodeCount", tree.nodes.size() }, { "leafDataCount", tree.leaves.size() },
            { "files", io::Json::array({ filename }) }, { "nodeEncoding", encoding }, { "compression", compression }
        };
        std::filesystem::create_directories(directory);
        const auto json = metadata.dump(2);
        logger.info("writing '", io::path_utf8(directory / "voxel-meta.json"), "'...");
        io::write_bytes(directory / "voxel-meta.json", std::span(reinterpret_cast<const uint8_t*>(json.data()), json.size()));
        logger.info("writing '", io::path_utf8(directory / filename), "'...");
        io::write_bytes(directory / filename, binary);
        const auto shape = config.value("collisionMesh", io::Json(false));
        size_t mesh_bytes = 0;
        if (shape != false) {
            if (shape != true && shape != "faces" && shape != "smooth") {
                throw std::runtime_error("collisionMesh must be true, false, faces, or smooth");
            }
            auto mesh_time = logger.time("Build collision mesh");
            auto mesh = shape == "faces" ? voxel_faces(grid, bounds, resolution) : marching_cubes(grid, bounds, resolution);
            logger.info(shape == "faces" ? "collision mesh faces: " : "collision mesh smooth: ", mesh.positions.size() / 3, " vertices, ", mesh.indices.size() / 3, " triangles");
            if (shape != "faces") {
                const auto original_triangles = mesh.indices.size() / 3;
                mesh = merge_coplanar(mesh, resolution);
                logger.info("collision mesh merged: ", mesh.positions.size() / 3, " vertices, ", mesh.indices.size() / 3, " triangles");
                if (original_triangles) {
                    logger.info("collision mesh reduction: ", utility::fixed((1 - float(mesh.indices.size() / 3) / original_triangles) * 100, 0), '%');
                }
            }
            mesh_time.finish();
            if (mesh.indices.empty()) {
                logger.warn("collision mesh: no triangles generated, skipping GLB output");
            } else {
                const auto glb = encode_glb(mesh);
                mesh_bytes = glb.size();
                logger.info("writing '", io::path_utf8(directory / "collision.glb"), "'...");
                io::write_bytes(directory / "collision.glb", glb);
            }
        }
        const auto size_message = compression == "none" ? "octree " + utility::format_size(raw_bytes)
                                                        : "octree raw: " + utility::format_size(raw_bytes) + ", " + compression + ": " + utility::format_size(binary.size()) +
                                                              " (" + utility::fixed(raw_bytes ? float(binary.size()) / raw_bytes * 100 : 0) + "%)";
        logger.info(size_message, mesh_bytes ? ", collision mesh " + utility::format_size(mesh_bytes) : "");
        return;
    }
}
} // namespace splat_transform::voxel
