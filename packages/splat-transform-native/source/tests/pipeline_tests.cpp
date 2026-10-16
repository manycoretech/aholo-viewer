#include "gpu/cluster_schedule.h"
#include "voxel/grid.h"
#include <chrono>
#include <cmath>
#include <io/file.h>
#include <iostream>
#include <pipeline/runner.h>
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
    io::write_bytes(path, std::span(reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}
void filter_neighborhoods() {
    std::mt19937_64 random(0x8193);
    for (const voxel::Point dimensions : { voxel::Point { 4, 4, 4 }, voxel::Point { 8, 12, 16 }, voxel::Point { 12, 8, 4 } }) {
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
            for (int z = 0; z < dimensions[2]; ++z) {
                for (int y = 0; y < dimensions[1]; ++y) {
                    for (int x = 0; x < dimensions[0]; ++x) {
                        const voxel::Point p { x, y, z };
                        const auto bits = grid.mask(grid.block_index({ x / 4, y / 4, z / 4 }));
                        int neighbors = 0;
                        for (int axis = 0; axis < 3; ++axis) {
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
    const voxel::Point center { 4, 4, 4 };
    for (int axis = 0; axis < 3; ++axis) {
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
        filter_neighborhoods();
        splat::Splat points(16, 3);
        for (size_t i = 0; i < points.size(); ++i) {
            for (size_t a = 0; a < 3; ++a) {
                points.gaussians[i].attribute(a) = float(std::sin((i + 1) * (a + 1)));
                points.gaussians[i].attribute(splat::ScaleX + a) = 0.125f;
                points.gaussians[i].attribute(splat::Red + a) = float((i + a) % 8) / 8;
            }
            points.gaussians[i].attribute(splat::Alpha) = 0.75f;
            points.gaussians[i].attribute(splat::QuatW) = 1;
            for (size_t c = 0; c < points.sh_count(); ++c) {
                points.gaussians[i].attribute(splat::ShOffset + c) = float(std::sin(i + c) * 0.1);
            }
        }
        io::write_splat(directory / "input.ply", points, { { "enableMortonSort", false } });
        for (const std::string extension : { "ply", "spz", "uspz", "splat", "esz" }) {
            const auto path = directory / ("roundtrip." + extension);
            io::write_splat(path, points, { { "enableMortonSort", false } });
            const auto decoded = io::read_splat(path);
            require(decoded.size() == points.size(), "Format roundtrip lost splats");
            require(decoded.sh_degree == (extension == "splat" ? 0u : 3u), "Format roundtrip lost SH bands");
            for (size_t i = 0; i < points.size(); ++i) {
                for (size_t a = 0; a < 3; ++a) {
                    require(std::abs(decoded.gaussians[i].attribute(a) - points.gaussians[i].attribute(a)) < 0.001, "Position quantization exceeded format tolerance");
                }
            }
        }
        io::write_splat(directory / "v4.spz", points, { { "version", 4 }, { "enableMortonSort", false } });
        require(io::read_splat(directory / "v4.spz").size() == points.size(), "SPZ v4 roundtrip failed");
        io::write_splat(directory / "high.esz", points, { { "highPrecision", true }, { "enableMortonSort", false } });
        const auto high = io::read_splat(directory / "high.esz");
        for (size_t i = 0; i < points.size(); ++i) {
            require(high.gaussians[i].mean.x() == points.gaussians[i].mean.x(), "High precision ESZ positions changed");
        }
        auto without_sh = points;
        without_sh.limit_sh_degree(0);
        io::write_splat(directory / "cpu.sog", without_sh, { { "enableMortonSort", false } });
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
            io::write_splat(directory / "rotations.ply", rotations, { { "enableMortonSort", false } });
            const auto canonical = io::read_splat(directory / "rotations.ply");
            require(canonical.gaussians[0].attribute(splat::QuatW) > 0, "Negative-w quaternion was not canonicalized");
            for (size_t c = splat::QuatX; c <= splat::QuatW; ++c) {
                require(canonical.gaussians[0].attribute(c) == canonical.gaussians[1].attribute(c), "Equivalent quaternion signs produced different values");
                require(canonical.gaussians[2].attribute(c) == 0, "Zero quaternion changed during input normalization");
            }
            io::write_splat(directory / "rotations.splat", canonical, { { "enableMortonSort", false } });
            const auto encoded = io::read_bytes(directory / "rotations.splat");
            constexpr std::array<uint8_t, 4> EXPECTED { 168, 88, 209, 47 };
            for (size_t c = 0; c < 4; ++c) {
                require(encoded[28 + c] == EXPECTED[c] && encoded[60 + c] == EXPECTED[c], "Quaternion quantization differs from the legacy sign convention");
                require(encoded[92 + c] == 128, "Zero quaternion quantization differs from the legacy encoding");
            }
        }
        io::Bytes scores;
        for (size_t i = 0; i < points.size(); ++i) {
            io::append(scores, float(i));
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
        for (int y = 0; y < 12; ++y) {
            for (int z = 0; z < 12; ++z) {
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
            const auto schedule = gpu::cluster_schedule(200003, 129, 48, { 128 * 1024 * 1024, 65535, budget });
            const auto bytes = (129 + schedule.batch_rows * (schedule.cached_batches + schedule.streaming_slots)) * 49 * sizeof(float);
            require(bytes <= budget, "Clustering schedule exceeded available memory");
            if (budget == 32 * 1024 * 1024) {
                require(schedule.streaming_slots > 0 && schedule.batch_rows < 200003, "Clustering did not schedule streaming input");
            } else {
                require(!schedule.streaming_slots && schedule.cached_batches == 1 && schedule.batch_rows == 200003, "Clustering split input that fits in one device buffer");
            }
        }
        bool rejected = false;
        try {
            pipeline::run({ { "version", 2 }, { "tasks", io::Json::array() } });
        } catch (const std::exception&) {
            rejected = true;
        }
        require(rejected, "Unsupported pipeline version accepted");
        std::cout << "Pipeline, formats, short scores, and voxel topology contracts passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
