#include "spatial/cluster_schedule.h"
#include "voxel/grid.h"
#include <chrono>
#include <cmath>
#include <cstdint>
#include <io/file.h>
#include <io/spz.h>
#include <iostream>
#include <numeric>
#include <pipeline/runner.h>
#include <pipeline/tasks/write.h>
#include <random>
#include <voxel/voxel.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
void save_json(const std::filesystem::path& path, const io::Json& json) {
    const auto text = json.dump();
    io::write_bytes(path, std::as_bytes(std::span(text)));
}
void write_options(const std::filesystem::path& directory, const splat::Splat& source) {
    pipeline::TaskContext context;
    context.set({ { "output", "source" } }, std::make_shared<splat::Splat>(source));
    std::vector<uint32_t> indices(source.size());
    std::iota(indices.begin(), indices.end(), 0);
    for (int32_t version : { 3, 4 }) {
        for (int32_t level : { 0, 1, 9 }) {
            const auto path = directory / "options.spz";
            io::Json config { { "input", "source" }, { "output", io::path_utf8(path) }, { "version", version }, { "enableMortonSort", false } };
            if (level) {
                config["compressLevel"] = level;
            }
            pipeline::WriteTask().exec(config, context);
            const auto expected = io::SpzFile(version, level ? level : 6).write(source, indices);
            require(io::read_bytes(path) == expected, "Pipeline lost SPZ version, compression level, or row order");
        }
    }
}
void write_gpu_requirements() {
    pipeline::TaskContext context;
    auto source = std::make_shared<splat::Splat>(1, 0);
    context.set({ { "output", "source" } }, source);
    pipeline::WriteTask task;
    // Encoding options are validated by exec, not by GPU requirement queries.
    io::Json config { { "input", "source" }, { "version", "unused" }, { "compressLevel", "unused" }, { "highPrecision", "unused" }, { "enableMortonSort", "unused" } };
    for (const auto extension : { ".ply", ".spz", ".uspz", ".splat", ".esz", ".SOG" }) {
        config["output"] = std::string("output") + extension;
        require(task.requires_gpu(config, context) == (std::string_view(extension) == ".SOG"), "GPU query parsed encoding options or misclassified an output format");
    }
    context.set({ { "output", "bundle" } }, std::vector<pipeline::SingleFile> { { "metadata.sog", std::string("metadata") }, { "data.esz", source } });
    config["input"] = "bundle";
    config["output"] = "bundle-directory";
    require(!task.requires_gpu(config, context), "Text bundle entries must not require GPU encoding");
    context.set({ { "output", "bundle" } }, std::vector<pipeline::SingleFile> { { "data.esz", source }, { "data.SOG", source } });
    require(task.requires_gpu(config, context), "GPU query missed a SOG entry in a mixed bundle");
}
static_assert(voxel::ValidBrickSize<4> && voxel::ValidBrickSize<12> && voxel::ValidBrickSize<32>);
static_assert(!voxel::ValidBrickSize<0> && !voxel::ValidBrickSize<6>);
template<uint32_t Side>
    requires voxel::ValidBrickSize<Side>
void brick_size_contract() {
    using Map = voxel::BrickMap<Side>;
    constexpr int32_t edge = Map::block_side;
    const Eigen::Vector3i dims = Eigen::Vector3i::Constant(edge + 1);
    Map map(dims);
    std::array<typename Map::Masks, 8> source;
    for (size_t i = 0; i < source.size(); ++i) {
        for (size_t j = 0; j < source[i].size(); ++j) {
            source[i][j] = i == 7 ? voxel::FULL_BLOCK : uint64_t { 1 } << ((i + j) % 64);
        }
    }
    map.assign_bricks(source.size(), [](size_t i) { return static_cast<uint32_t>(i); }, [&](size_t i) -> const typename Map::Masks& { return source[i]; });
    uint64_t voxels = 0;
    size_t visited = 0;
    map.for_each_block(0, [&](Eigen::Vector3i p, uint64_t bits) {
        require((p.array() >= 0).all() && (p.array() < dims.array()).all(), "Brick traversal visited padding");
        const auto id = p.x() / edge + 2 * (p.y() / edge + 2 * (p.z() / edge));
        const auto local = p.x() % edge + edge * (p.y() % edge + edge * (p.z() % edge));
        require(bits == source[id][local] && map.get(p) == bits, "Brick size changed traversal or addressing");
        voxels += std::popcount(bits);
        ++visited;
    });
    require(visited == static_cast<size_t>(dims.prod()) && map.occupied_blocks() == visited && map.voxel_count() == voxels, "Brick size changed valid counts");
    map.invert();
    map.set(dims - Eigen::Vector3i::Ones(), 5);
    require(map.voxel_count() == visited * 64 - voxels + 2, "Updating an inverse edge brick changed other voxels");
}
void brick_storage() {
    brick_size_contract<4>();
    brick_size_contract<8>();
    brick_size_contract<12>();
    brick_size_contract<32>();
    voxel::Grid grid({ 20, 20, 20 });
    const std::array<uint32_t, 8> ids { 5, 0, 2, 7, 4, 1, 3, 6 };
    std::array<voxel::Grid::Storage::Masks, 8> bricks;
    for (size_t i = 0; i < bricks.size(); ++i) {
        for (uint32_t j = 0; j < 64; ++j) {
            bricks[i][j] = uint64_t { 1 } << j;
        }
    }
    // The last brick has just one valid block. Its padding must not affect
    // uniform compression, traversal, or counting.
    bricks[7][0] = voxel::FULL_BLOCK;
    grid.masks.assign_bricks(ids.size(), [&](size_t i) { return ids[i]; }, [&](size_t i) -> const voxel::Grid::Storage::Masks& { return bricks[ids[i]]; });
    std::array<uint64_t, 125> expected;
    for (uint32_t i = 0; i < expected.size(); ++i) {
        const auto p = grid.block_point(i);
        const auto brick = p.x() / 4 + 2 * (p.y() / 4) + 4 * (p.z() / 4);
        expected[i] = bricks[brick][(p.x() % 4) + 4 * (p.y() % 4) + 16 * (p.z() % 4)];
    }
    const auto check = [&](const voxel::Grid& actual, uint64_t flip) {
        uint64_t voxels = 0;
        std::vector<uint32_t> active;
        for (uint32_t i = 0; i < expected.size(); ++i) {
            const auto bits = expected[i] ^ flip;
            require(actual.mask(i) == bits, "Brick directory returned the wrong pool slot");
            voxels += std::popcount(bits);
            if (bits) {
                active.push_back(i);
            }
        }
        require(actual.active_blocks() == active && actual.voxel_count() == voxels, "Partial brick traversal or ordering differs");
    };
    check(grid, 0);
    for (uint32_t i = 0; i < expected.size(); ++i) {
        const auto p = grid.block_point(i);
        if (p.y() < 4 && p.z() < 4) {
            expected[i] = p.x() < 4 ? 0 : voxel::FULL_BLOCK;
            grid.set_mask(i, expected[i]);
        }
    }
    check(grid, 0);
    auto inverse = grid.inverted();
    check(inverse, voxel::FULL_BLOCK);
    inverse.masks.set({ 4, 4, 4 }, 13);
    require(grid.masks.get({ 4, 4, 4 }) == voxel::FULL_BLOCK, "Mutating an inverted copy changed its source");
    const auto crop = inverse.crop({ 1, 1, 1 }, { 5, 5, 5 }, true);
    for (uint32_t i = 0; i < crop.block_count(); ++i) {
        require(crop.mask(i) == ~inverse.masks.get(crop.block_point(i) + Eigen::Vector3i::Ones()), "Unaligned inverted brick crop differs");
    }
    const auto solid = voxel::unite(grid, grid.inverted());
    require(solid.voxel_count() == expected.size() * 64 && solid.inverted().masks.empty(), "Uniform edge brick union differs");
}
void filter_neighborhoods() {
    std::mt19937_64 random(0x8193);
    for (const Eigen::Vector3i dimensions : { Eigen::Vector3i { 4, 4, 4 }, Eigen::Vector3i { 8, 12, 16 }, Eigen::Vector3i { 12, 8, 4 } }) {
        for (bool inverted : { false, true }) {
            voxel::Grid grid(dimensions);
            for (uint32_t index = 0; index < grid.block_count(); ++index) {
                grid.set_mask(index, index % 7 == 0 ? 0 : index % 7 == 1 ? voxel::FULL_BLOCK
                                                                         : random());
            }
            if (inverted) {
                grid = grid.inverted();
            }
            const auto filtered = voxel::filter_blocks(grid);
            for (int32_t z = 0; z < dimensions[2]; ++z) {
                for (int32_t y = 0; y < dimensions[1]; ++y) {
                    for (int32_t x = 0; x < dimensions[0]; ++x) {
                        const Eigen::Vector3i p { x, y, z };
                        const auto bits = grid.mask(grid.block_index({ x / 4, y / 4, z / 4 }));
                        int32_t neighbors = 0;
                        for (int32_t axis = 0; axis < 3; ++axis) {
                            auto neighbor = p;
                            --neighbor[axis];
                            neighbors += grid.get(neighbor);
                            neighbor[axis] += 2;
                            neighbors += grid.get(neighbor);
                        }
                        const bool expected = bits == voxel::FULL_BLOCK || (bits != 0 && (grid.get(p) ? neighbors != 0 : neighbors == 6));
                        require(filtered.get(p) == expected, "Blockwise filtering changed a scalar six-neighbor decision");
                    }
                }
            }
        }
    }
    voxel::Grid shell({ 12, 12, 12 });
    const Eigen::Vector3i center { 4, 4, 4 };
    for (int32_t axis = 0; axis < 3; ++axis) {
        auto p = center;
        --p[axis];
        shell.set(p);
        p[axis] += 2;
        shell.set(p);
    }
    const auto filtered = voxel::filter_blocks(shell);
    require(filtered.get(center) && filtered.voxel_count() == 1, "Cross-face hole filling must use the original neighbors");
}
} // namespace
int main() {
    const auto directory = std::filesystem::temp_directory_path() / ("splat-transform-tests-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup { directory };
    try {
        require(pipeline::PathResolver().resolve("").empty(), "Resolving an empty path must preserve it");
        brick_storage();
        filter_neighborhoods();
        splat::Splat points(16, 3);
        for (size_t i = 0; i < points.size(); ++i) {
            for (size_t a = 0; a < 3; ++a) {
                points.gaussians[i].attribute(a) = static_cast<float>(std::sin((i + 1) * (a + 1)));
                points.gaussians[i].attribute(splat::ScaleX + a) = 0.125f;
                points.gaussians[i].attribute(splat::Red + a) = static_cast<float>((i + a) % 8) / 8;
            }
            points.gaussians[i].attribute(splat::Alpha) = 0.75f;
            points.gaussians[i].attribute(splat::QuatW) = 1;
            for (size_t c = 0; c < points.sh_count(); ++c) {
                points.gaussians[i].attribute(splat::ShOffset + c) = static_cast<float>(std::sin(i + c) * 0.1);
            }
        }
        write_gpu_requirements();
        write_options(directory, points);
        io::write_splat(directory / "input.ply", points, { .enable_morton_sort = false });
        for (const std::string extension : { "ply", "spz", "uspz", "splat", "esz" }) {
            const auto path = directory / ("roundtrip." + extension);
            io::write_splat(path, points, { .enable_morton_sort = false });
            const auto decoded = io::read_splat(path);
            require(decoded.size() == points.size(), "Format roundtrip lost splats");
            require(decoded.sh_degree == (extension == "splat" ? 0u : 3u), "Format roundtrip lost SH bands");
            for (size_t i = 0; i < points.size(); ++i) {
                for (size_t a = 0; a < 3; ++a) {
                    require(std::abs(decoded.gaussians[i].attribute(a) - points.gaussians[i].attribute(a)) < 0.001, "Position quantization exceeded format tolerance");
                }
            }
        }
        io::write_splat(directory / "v4.spz", points, { .version = 4, .enable_morton_sort = false });
        require(io::read_splat(directory / "v4.spz").size() == points.size(), "SPZ v4 roundtrip failed");
        io::write_splat(directory / "high.esz", points, { .high_precision = true, .enable_morton_sort = false });
        const auto high = io::read_splat(directory / "high.esz");
        for (size_t i = 0; i < points.size(); ++i) {
            require(high.gaussians[i].mean.x() == points.gaussians[i].mean.x(), "High precision ESZ positions changed");
        }
        auto without_sh = points;
        without_sh.limit_sh_degree(0);
        io::write_splat(directory / "cpu.sog", without_sh, { .enable_morton_sort = false });
        require(io::read_splat(directory / "cpu.sog").size() == points.size(), "SH0 SOG requires no Vulkan runtime");
        {
            splat::Splat rotations(3, 0);
            const std::array<float, 4> quaternion { 0.25f, -0.5f, 0.5f, -0.25f };
            for (size_t i = 0; i < rotations.size(); ++i) {
                for (size_t a = 0; a < 3; ++a) {
                    rotations.gaussians[i].attribute(splat::ScaleX + a) = 1;
                }
                rotations.gaussians[i].attribute(splat::Alpha) = 0.5f;
                for (size_t c = 0; c < 4; ++c) {
                    rotations.gaussians[i].attribute(splat::QuatX + c) = i == 2 ? 0 : quaternion[c] * (i == 0 ? 1 : -1);
                }
            }
            io::write_splat(directory / "rotations.ply", rotations, { .enable_morton_sort = false });
            const auto normalized = io::read_splat(directory / "rotations.ply");
            require(normalized.gaussians[0].rotation.w() < 0 && normalized.gaussians[1].rotation.w() > 0, "Input normalization changed quaternion signs");
            require(std::abs(normalized.gaussians[0].rotation.norm() - 1) < 1e-6f, "Input normalization did not produce a unit quaternion");
            require(normalized.gaussians[0].rotation.angularDistance(normalized.gaussians[1].rotation) < 1e-6f, "Equivalent quaternion signs changed rotation");
            for (size_t c = splat::QuatX; c <= splat::QuatW; ++c) {
                require(normalized.gaussians[0].attribute(c) == -normalized.gaussians[1].attribute(c), "Input normalization changed quaternion component signs");
                require(normalized.gaussians[2].attribute(c) == 0, "Zero quaternion changed during input normalization");
            }
            io::write_splat(directory / "rotations.splat", normalized, { .enable_morton_sort = false });
            const auto encoded = io::read_bytes(directory / "rotations.splat");
            constexpr std::array<std::byte, 4> EXPECTED { std::byte { 168 }, std::byte { 88 }, std::byte { 209 }, std::byte { 47 } };
            for (size_t c = 0; c < 4; ++c) {
                require(encoded[28 + c] == EXPECTED[c] && encoded[60 + c] == EXPECTED[c], "Quaternion quantization differs from the legacy sign convention");
                require(encoded[92 + c] == std::byte { 128 }, "Zero quaternion quantization differs from the legacy encoding");
            }
        }
        io::Bytes scores;
        for (size_t i = 0; i < points.size(); ++i) {
            io::append(scores, static_cast<float>(i));
        }
        io::write_bytes(directory / "scores.bin", scores);
        const auto path = [&](const char* name) { return (directory / name).generic_string(); };
        pipeline::run({ { "version", 1 }, { "tasks", io::Json::array({ { { "id", "read" }, { "type", "Read" }, { "config", { { "inputs", io::Json::array({ path("input.ply") }) }, { "output", "data" } } } },
                                                         { { "id", "flex" }, { "type", "FlexLod" }, { "config", { { "input", "data" }, { "output", "filtered" }, { "ratio", 0.25 }, { "scorePath", path("scores.bin") }, { "originalIndices", path("indices.bin") } } }, { "release", io::Json::array({ "data" }) } },
                                                         { { "id", "write" }, { "type", "Write" }, { "config", { { "input", "filtered" }, { "output", path("filtered.ply") }, { "enableMortonSort", false } } } } }) } });
        const auto filtered = io::read_splat(directory / "filtered.ply");
        require(filtered.size() == 4, "FlexLod count differs");
        const auto indices = io::read_bytes(directory / "indices.bin");
        io::ByteReader index_reader(indices);
        for (uint32_t i = 12; i < 16; ++i) {
            require(index_reader.read<uint32_t>() == i, "Short score file was read at the wrong offset");
        }
        voxel::Grid wall({ 12, 12, 12 });
        for (int32_t y = 0; y < 12; ++y) {
            for (int32_t z = 0; z < 12; ++z) {
                wall.set({ 5, y, z });
            }
        }
        auto reachable = voxel::flood(wall.inverted(), { { 0, 0, 0 } });
        require(reachable.voxel_count() == 5 * 12 * 12, "Flood crossed a solid wall");
        wall.set_mask(wall.block_index({ 1, 1, 1 }), 0);
        reachable = voxel::flood(wall.inverted(), { { 0, 0, 0 } });
        require(reachable.get({ 11, 11, 11 }), "Flood failed to cross a block boundary opening");
        voxel::Grid single({ 12, 12, 12 });
        single.set({ 5, 5, 5 });
        require(voxel::filter_blocks(single).voxel_count() == 0, "Isolated voxel was not filtered");
        for (const size_t budget : { 32 * 1024 * 1024, 48 * 1024 * 1024 }) {
            const auto schedule = spatial::cluster_schedule(200003, 129, 48, { 128 * 1024 * 1024, 65535, budget });
            const auto bytes = (129 + schedule.batch_rows * (schedule.cached_batches + schedule.streaming_slots)) * 49 * sizeof(float);
            require(bytes <= budget, "Clustering schedule exceeded available memory");
            if (budget == 32 * 1024 * 1024) {
                require(schedule.streaming_slots > 0 && schedule.batch_rows < 200003, "Clustering did not schedule streaming input");
            } else {
                require(!schedule.streaming_slots && schedule.cached_batches == 1 && schedule.batch_rows == 200003, "Clustering split input that fits in one device buffer");
            }
            const auto batched = spatial::cluster_schedule(200003, 129, 48, { 128 * 1024 * 1024, 65535, budget }, 8192);
            const auto batched_bytes = (129 + batched.batch_rows * (batched.cached_batches + batched.streaming_slots)) * 49 * sizeof(float);
            require(batched.batch_rows == 8192 && batched_bytes <= budget, "Callback batching exceeded the row or memory budget");
            require((budget == 32 * 1024 * 1024) == (batched.streaming_slots != 0), "Callback batching changed cached/streaming budget selection");
        }
        std::cout << "Pipeline, formats, short scores, and voxel topology contracts passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
