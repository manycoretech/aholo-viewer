#include "voxelize.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <codec/codec.h>
#include <cstdint>
#include <io/file.h>
#include <io/json.h>
#include <limits>
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
uint64_t morton(Eigen::Vector3i p) {
    const auto spread = [](uint32_t value) {
        uint64_t bits = value & 0x1fffffu;
        bits = (bits | (bits << 32)) & 0x1f00000000ffffull;
        bits = (bits | (bits << 16)) & 0x1f0000ff0000ffull;
        bits = (bits | (bits << 8)) & 0x100f00f00f00f00full;
        bits = (bits | (bits << 4)) & 0x10c30c30c30c30c3ull;
        return (bits | (bits << 2)) & 0x1249249249249249ull;
    };
    return spread(p[0]) | (spread(p[1]) << 1) | (spread(p[2]) << 2);
}
Octree build_octree(const Grid& grid) {
    struct Node {
        uint64_t key;
        uint64_t mask = 0;
        // Child range start; leaves use the original grid index to break ties.
        uint32_t begin = 0;
        uint8_t children = 0;
        bool solid = false;
    };
    using Level = std::vector<Node>;
    Octree output;
    std::vector<Level> levels(1);
    auto& leaves = levels.front();
    leaves.reserve(grid.masks.occupied_blocks());
    grid.masks.for_each_block(0, [&](Eigen::Vector3i p, uint64_t mask) {
        leaves.push_back({ morton(p), mask, grid.block_index(p), 0, mask == FULL_BLOCK });
    });
    if (leaves.empty()) {
        return output;
    }
    std::sort(leaves.begin(), leaves.end(), [](const Node& left, const Node& right) {
        return left.key != right.key ? left.key < right.key : left.begin > right.begin;
    });
    // Preserve the last linear-grid entry if coordinates alias in the existing
    // 21-bit Morton encoding, as the previous sorted map insertion did.
    leaves.erase(
        std::unique(
            leaves.begin(), leaves.end(), [](const Node& left, const Node& right) { return left.key == right.key; }
        ),
        leaves.end()
    );
    size_t node_count = leaves.size();
    const auto mixed_count = std::ranges::count_if(leaves, [](const Node& node) { return !node.solid; });
    do {
        const auto& children = levels.back();
        Level parents;
        parents.reserve((children.size() + 3) / 4);
        // Morton order keeps every parent's children in one contiguous range.
        for (size_t begin = 0; begin < children.size();) {
            Node parent { children[begin].key >> 3, 0, static_cast<uint32_t>(begin), 0, true };
            do {
                const auto& child = children[begin++];
                parent.children |= static_cast<uint8_t>(1u << (child.key & 7));
                parent.solid &= child.solid;
            } while (begin < children.size() && (children[begin].key >> 3) == parent.key);
            parent.solid &= parent.children == 0xff;
            parents.push_back(parent);
        }
        node_count += parents.size();
        levels.push_back(std::move(parents));
    } while (levels.back().size() != 1 || levels.back().front().key != 0);
    output.depth = static_cast<uint32_t>(levels.size() - 1);
    output.nodes.reserve(node_count);
    output.leaves.reserve(static_cast<size_t>(mixed_count) * 2);
    std::vector<uint32_t> wave { 0 }, next;
    for (size_t level = levels.size(); level-- > 0;) {
        next.clear();
        uint64_t first = output.nodes.size() + wave.size();
        for (const auto index : wave) {
            const auto& node = levels[level][index];
            if (node.solid) {
                output.nodes.push_back(0xff000000u);
            } else if (level == 0) {
                if (output.mixed > 0xffffff) {
                    throw OctreeOverflow(static_cast<uint64_t>(output.mixed) + 1);
                }
                output.nodes.push_back(output.mixed++);
                output.leaves.push_back(static_cast<uint32_t>(node.mask));
                output.leaves.push_back(static_cast<uint32_t>(node.mask >> 32));
            } else {
                if (first > 0xffffff) {
                    throw OctreeOverflow(first + 1);
                }
                output.nodes.push_back((static_cast<uint32_t>(node.children) << 24) | static_cast<uint32_t>(first));
                ++output.interiors;
                const uint32_t count = std::popcount(node.children);
                for (uint32_t child = 0; child < count; ++child) {
                    next.push_back(node.begin + child);
                }
                first += count;
            }
        }
        wave.swap(next);
    }
    return output;
}
io::Bytes encode_octree(const Octree& tree, bool compact) {
    io::Bytes output;
    if (compact) {
        const uint32_t tag_bytes = static_cast<uint32_t>((tree.nodes.size() + 3) / 4);
        for (uint32_t value : { 0x31424356u, 1u, static_cast<uint32_t>(tree.nodes.size()), tree.interiors, tree.mixed,
                 static_cast<uint32_t>(tree.leaves.size()), tag_bytes, tree.interiors }) {
            io::append(output, value);
        }
        io::Bytes tags(tag_bytes), masks;
        for (size_t i = 0; i < tree.nodes.size(); ++i) {
            const auto node = tree.nodes[i];
            const uint8_t tag = node == 0xff000000u ? 1 : (node >> 24) ? 2
                                                                       : 0;
            tags[i / 4] |= static_cast<std::byte>(tag) << ((i % 4) * 2);
            if (tag == 2) {
                masks.push_back(static_cast<std::byte>(node >> 24));
            }
        }
        output.insert(output.end(), tags.begin(), tags.end());
        output.insert(output.end(), masks.begin(), masks.end());
        output.resize((output.size() + 3) & ~size_t { 3 }, std::byte {});
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
Occupancy voxelize_occupancy(
    const PreparedData& data, const Backend& backend, const Eigen::AlignedBox3f& bounds, GridSpec spec
) {
    auto timer = utility::logger().time("Voxelizing (" + std::string(backend.name()) + ") done");
    return { backend.voxelize(data, bounds, spec.voxel_resolution, spec.opacity_cutoff), bounds, spec };
}
} // namespace
Occupancy generate_occupancy(const splat::Splat& data, GridSpec spec) {
    auto prepared = prepare(data);
    if (prepared.gaussians.empty() || !prepared.scene.min().allFinite() || !prepared.scene.max().allFinite()) {
        return { Grid {},
            Eigen::AlignedBox3f(Eigen::Vector3f::Zero(), Eigen::Vector3f::Constant(4 * spec.voxel_resolution)), spec };
    }
    const auto bounds = align_bounds(prepared.scene, spec.voxel_resolution);
    auto backend = resolve_backend(BackendType::Gpu);
    return voxelize_occupancy(prepared, *backend, bounds, spec);
}
namespace {
struct CollisionVolume {
    Occupancy collision;
    Eigen::AlignedBox3f scene;
    Octree tree;
    std::vector<Occupancy> filter_grids;
};

CollisionVolume generate_collision(const splat::Splat& input, const Options& options) {
    auto& logger = utility::logger();
    const auto backend = resolve_backend(options.backend);
    float resolution = options.voxel_resolution;
    const auto requested_resolution = resolution;
    const float cutoff = options.opacity_cutoff;
    if (!(resolution > 0) || !std::isfinite(resolution) || !std::isfinite(cutoff) || cutoff < 0 || cutoff > 1) {
        throw std::runtime_error("Invalid voxel resolution or opacityCutoff");
    }
    // Voxelization needs geometry and opacity only. Retain one packed buffer
    // through bounds resolution and filtering; never clone the source's SH data.
    auto bounds_time = logger.time("Voxel bounding/extents");
    auto prepared = prepare(input);
    bounds_time.finish();
    const auto box = resolve_box(input, prepared.scene, options.box, options.auto_dense_box);
    std::vector<Occupancy> filter_grids;
    if (options.filter_cluster) {
        logger.info("voxel filterCluster enabled");
        auto filter_time = logger.time("Filter clusters");
        if (auto original = filter_cluster(prepared, *options.filter_cluster, box, *backend)) {
            filter_grids.push_back(std::move(*original));
        }
    }
    if (!prepared.invalid_extents.empty()) {
        logger.info("voxel: skipped ", prepared.invalid_extents.size(), " gaussians with invalid extent values");
    }
    logger.info(
        "scene extents: (", utility::fixed(prepared.scene.min()[0]), ',', utility::fixed(prepared.scene.min()[1]), ',',
        utility::fixed(prepared.scene.min()[2]), ") - (", utility::fixed(prepared.scene.max()[0]), ',',
        utility::fixed(prepared.scene.max()[1]), ',', utility::fixed(prepared.scene.max()[2]), ')'
    );
    const auto& navigation = options.navigation;
    if (navigation.floor_dilation < 0 || navigation.exterior_radius < 0) {
        throw std::runtime_error("Navigation dilation must be nonnegative");
    }
    const bool has_exterior = navigation.exterior_radius != 0 && navigation.seed.has_value();
    auto resolve_bounds = [&] {
        const float exterior_pad =
            has_exterior ? (std::ceil(navigation.exterior_radius / resolution) + 1) * resolution : 0;
        const float floor_pad =
            navigation.floor_fill ? (std::ceil(navigation.floor_dilation / resolution) + 1) * resolution : 0;
        auto bounds = prepared.scene;
        for (int32_t a = 0; a < 3; ++a) {
            const float pad = a == 1 ? exterior_pad : std::max(exterior_pad, floor_pad);
            bounds.min()[a] = std::max(bounds.min()[a] - pad, box.min()[a]);
            bounds.max()[a] = std::min(bounds.max()[a] + pad, box.max()[a]);
            if (!(bounds.min()[a] < bounds.max()[a])) {
                throw std::runtime_error("Voxel box does not overlap scene bounds");
            }
        }
        return align_bounds(bounds, resolution);
    };
    for (int32_t attempt = 0; attempt <= 4; ++attempt) {
        auto bounds = resolve_bounds();
        for (int32_t grid_attempt = 0; grid_attempt < 4; ++grid_attempt) {
            float count = 1;
            for (int32_t a = 0; a < 3; ++a) {
                count *= std::round((bounds.max()[a] - bounds.min()[a]) / (4 * resolution));
            }
            const float target = static_cast<float>(std::floor(std::numeric_limits<int32_t>::max() * 0.55));
            if (count <= target) {
                break;
            }
            const auto next_resolution = fallback_resolution(resolution, count, target);
            logger.info(
                "voxel resolution fallback: grid blocks total=", count, ", target=", target, "; resolution ",
                resolution, " -> ", next_resolution
            );
            resolution = next_resolution;
            bounds = resolve_bounds();
        }
        if (resolution != requested_resolution) {
            logger.info("voxel effective resolution=", resolution, " (requested=", requested_resolution, ')');
        }
        std::optional<Occupancy> filter_grid;
        Grid grid;
        {
            auto raw = voxelize_occupancy(prepared, *backend, bounds, { resolution, cutoff });
            auto filter_time = logger.time("Filter blocks");
            grid = filter_blocks(raw.grid);
            // Only the full input can publish a raw occupancy grid to its lineage.
            if (prepared.gaussians.size() == input.size() && bounds.contains(prepared.scene)) {
                filter_grid.emplace(std::move(raw));
            }
        }
        navigate(grid, bounds, resolution, navigation, *backend);
        {
            auto crop_time = logger.time("Crop voxel bounds");
            crop_grid(
                grid, bounds, resolution, has_exterior || navigation.floor_fill,
                has_exterior || navigation.floor_fill ? 1 : 0
            );
        }
        Octree tree;
        try {
            auto tree_time = logger.time("Build octree");
            tree = build_octree(grid);
        } catch (const OctreeOverflow& error) {
            if (attempt == 4) {
                throw;
            }
            const auto next_resolution =
                fallback_resolution(resolution, static_cast<float>(error.count), std::floor(0x1000000 * 0.98f));
            logger.info(
                "voxel resolution fallback: octree nodes=", error.count, "; resolution ", resolution, " -> ",
                next_resolution
            );
            resolution = next_resolution;
            continue;
        }
        if (filter_grid) {
            filter_grids.push_back(std::move(*filter_grid));
        }
        return { { std::move(grid), bounds, { resolution, cutoff } }, prepared.scene, std::move(tree),
            std::move(filter_grids) };
    }
    throw std::logic_error("Voxel generation exhausted its attempts");
}
} // namespace

void write(
    const splat::Splat& input, const std::filesystem::path& directory, const Options& options,
    const std::function<void(Occupancy&&)>& cache_grid
) {
    auto generated = generate_collision(input, options);
    const auto& [grid, bounds, spec] = generated.collision;
    const auto& tree = generated.tree;
    const float resolution = spec.voxel_resolution;
    auto& logger = utility::logger();
    constexpr std::array COMPRESSION_NAMES { "none", "gzip", "zstd" };
    constexpr std::array ENCODING_NAMES { "raw", "compact" };
    const std::string compression = COMPRESSION_NAMES[static_cast<size_t>(options.compression)];
    const std::string encoding = ENCODING_NAMES[static_cast<size_t>(options.node_encoding)];
    logger.info("octree: depth=", tree.depth, ", interior=", tree.interiors, ", mixed=", tree.mixed);
    auto binary = encode_octree(tree, options.node_encoding == NodeEncoding::Compact);
    const auto raw_bytes = binary.size();
    std::string filename = "voxel.bin";
    if (options.compression == Compression::Gzip) {
        binary = codec::gzip(binary);
        filename += ".gz";
    }
    if (options.compression == Compression::Zstd) {
        binary = codec::zstd_compress(binary, 12);
        filename += ".zst";
    }
    const io::Json metadata { { "version", "1.2" }, { "gridBounds", io::bounds_json(bounds) },
        { "sceneBounds", io::bounds_json(generated.scene) }, { "voxelResolution", resolution }, { "leafSize", 4 },
        { "treeDepth", tree.depth }, { "numInteriorNodes", tree.interiors }, { "numMixedLeaves", tree.mixed },
        { "nodeCount", tree.nodes.size() }, { "leafDataCount", tree.leaves.size() },
        { "files", io::Json::array({ filename }) }, { "nodeEncoding", encoding }, { "compression", compression } };
    std::filesystem::create_directories(directory);
    const auto json = metadata.dump(2);
    logger.info("writing '", (directory / "voxel-meta.json").string(), "'...");
    io::write_bytes(directory / "voxel-meta.json", std::as_bytes(std::span(json)));
    logger.info("writing '", (directory / filename).string(), "'...");
    io::write_bytes(directory / filename, binary);
    const auto shape = options.collision_mesh;
    size_t mesh_bytes = 0;
    if (shape != CollisionMesh::None) {
        auto mesh_time = logger.time("Build collision mesh");
        auto mesh = shape == CollisionMesh::Faces ? voxel_faces(grid, bounds, resolution)
                                                  : marching_cubes(grid, bounds, resolution);
        logger.info(
            shape == CollisionMesh::Faces ? "collision mesh faces: " : "collision mesh smooth: ",
            mesh.positions.size() / 3, " vertices, ", mesh.indices.size() / 3, " triangles"
        );
        if (shape != CollisionMesh::Faces) {
            const auto original_triangles = mesh.indices.size() / 3;
            mesh = merge_coplanar(mesh, resolution);
            logger.info(
                "collision mesh merged: ", mesh.positions.size() / 3, " vertices, ", mesh.indices.size() / 3,
                " triangles"
            );
            if (original_triangles) {
                logger.info(
                    "collision mesh reduction: ",
                    utility::fixed((1 - static_cast<float>(mesh.indices.size() / 3) / original_triangles) * 100, 0), '%'
                );
            }
        }
        mesh_time.finish();
        if (mesh.indices.empty()) {
            logger.warn("collision mesh: no triangles generated, skipping GLB output");
        } else {
            const auto glb = encode_glb(mesh);
            mesh_bytes = glb.size();
            logger.info("writing '", (directory / "collision.glb").string(), "'...");
            io::write_bytes(directory / "collision.glb", glb);
        }
    }
    const auto size_message =
        compression == "none"
            ? "octree " + utility::format_size(raw_bytes)
            : "octree raw: " + utility::format_size(raw_bytes) + ", " + compression + ": " +
                  utility::format_size(binary.size()) + " (" +
                  utility::fixed(raw_bytes ? static_cast<float>(binary.size()) / raw_bytes * 100 : 0) + "%)";
    logger.info(size_message, mesh_bytes ? ", collision mesh " + utility::format_size(mesh_bytes) : "");
    if (cache_grid) {
        for (auto& field : generated.filter_grids) {
            cache_grid(std::move(field));
        }
    }
}
} // namespace splat_transform::voxel
