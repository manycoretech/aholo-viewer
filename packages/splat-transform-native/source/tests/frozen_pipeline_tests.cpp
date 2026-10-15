#include <chrono>
#include <cmath>
#include <iostream>
#include <pipeline/runner.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
void save_json(const std::filesystem::path& path, const io::Json& value) {
    const auto text = value.dump();
    io::write_bytes(path, { reinterpret_cast<const uint8_t*>(text.data()), text.size() });
}
void prepare(const std::filesystem::path& directory) {
    std::filesystem::create_directories(directory / "inputs");
    std::filesystem::create_directories(directory / "outputs");
    for (const bool second : { false, true }) {
        splat::Splat data(second ? 7 : 12, 3);
        for (size_t i = 0; i < data.size(); ++i) {
            auto& point = data.gaussians[i];
            point.mean = { float(i) * 0.125f + (second ? 100 : 0), float(i % 3) * 0.125f, float(i % 5) * 0.0625f };
            point.scale = { 0.125f, 0.25f, 0.0625f };
            point.rotation.w() = 1;
            point.opacity = 0.75f;
            for (size_t c = 0; c < point.sh.size(); ++c) {
                point.sh[c] = c < 3 ? float((i + c) % 4 + 1) * 0.125f : float(std::sin(i + c) * 0.05);
            }
        }
        io::write_splat(directory / "inputs" / (second ? "second.ply" : "first.ply"), data, { { "enableMortonSort", false } });
        save_json(directory / "inputs" / (second ? "second.json" : "first.json"),
            { { "transform", { 1, 0, 0, second ? -10 : 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1 } }, { "deletedIndices", { second ? 4 : 2 } } });
    }
    io::Bytes scores;
    for (size_t i = 0; i < 19; ++i) {
        io::append(scores, float(i));
    }
    io::write_bytes(directory / "inputs/scores.bin", scores);
}
void equal_data(const splat::Splat& first, const splat::Splat& second) {
    require(first.size() == second.size() && first.sh_degree == second.sh_degree, "Frozen pipeline changed output schema");
    for (size_t row = 0; row < first.size(); ++row) {
        for (size_t c = 0; c < first.attribute_count(); ++c) {
            require(first.gaussians[row].attribute(c) == second.gaussians[row].attribute(c), "Frozen pipeline changed an attribute or alias");
        }
    }
}
void verify(const std::filesystem::path& fixtures) {
    for (const auto name : { "read-modify", "formats", "auto-lod", "auto-chunk-defaults", "auto-chunk-business", "flex-lod", "skeleton-lod", "split-splat" }) {
        pipeline::run(io::read_json(fixtures / (std::string(name) + ".json")));
    }
    const auto source = io::read_splat("outputs/modify-source.ply");
    require(source.size() == 17 && source.sh_degree == 3, "Legacy Modify changed its deletion or SH behavior");
    equal_data(source, io::read_splat("outputs/modify-alias.ply"));
    equal_data(source, io::read_splat("outputs/modify-result.ply"));
    size_t row = 0;
    for (size_t i = 0; i < 19; ++i) {
        if (i == 1 || i == 14) {
            continue;
        }
        const float expected_x = i < 12 ? float(i) * 0.125f + 10 : float(i - 12) * 0.125f + 90;
        require(source.gaussians[row++].mean.x() == expected_x, "Read order or block-relative patch behavior changed");
    }
    equal_data(io::read_splat("outputs/high.esz"), io::read_splat("outputs/repeated-high.esz"));
    equal_data(io::read_splat("outputs/auto-default.ply"), io::read_splat("outputs/auto-explicit.ply"));
    const auto indices = io::read_bytes("outputs/original-indices.bin");
    require(indices.size() == 6 * sizeof(uint32_t), "FlexLod default target rounding changed");
    io::ByteReader reader(indices);
    for (uint32_t i = 13; i < 19; ++i) {
        require(reader.read<uint32_t>() == i, "FlexLod original index order changed");
    }
    const auto meta = io::read_json("outputs/default-low/lod-meta.json");
    require(meta == io::read_json("outputs/default-high/lod-meta.json") && meta == io::read_json("outputs/default-high-repeat/lod-meta.json"), "Repeated Write changed default LOD metadata");
    for (const auto& name : meta.at("files")) {
        equal_data(io::read_splat(std::filesystem::path("outputs/default-high") / name.get<std::string>()), io::read_splat(std::filesystem::path("outputs/default-high-repeat") / name.get<std::string>()));
    }
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 3 && std::string_view(argv[1]) == "--prepare") {
            prepare(io::utf8_path(argv[2]));
            return 0;
        }
        require(argc == 2, "Expected the frozen pipeline fixture directory");
        const auto fixtures = std::filesystem::absolute(io::utf8_path(argv[1]));
        const auto directory = std::filesystem::temp_directory_path() / ("splat-frozen-pipelines-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(directory);
        struct Cleanup {
            std::filesystem::path directory;
            std::filesystem::path previous;
            ~Cleanup() {
                std::error_code error;
                std::filesystem::current_path(previous, error);
                std::filesystem::remove_all(directory, error);
            }
        } cleanup { directory, std::filesystem::current_path() };
        prepare(directory);
        std::filesystem::current_path(directory);
        verify(fixtures);
        std::cout << "Eight frozen version 1 pipelines execute unchanged with relative cwd paths\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
