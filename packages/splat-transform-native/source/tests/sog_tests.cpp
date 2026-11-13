#include <chrono>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <functional>
#include <gpu/context.h>
#include <io/resource.h>
#include <io/sog.h>
#include <io/spz.h>
#include <iostream>
#include <numeric>
#include <pipeline/tasks/write.h>
#include <random>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
template<typename Action>
void rejects(Action&& action) {
    try {
        action();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error("Invalid SOG input was accepted");
}
io::Bytes json_bytes(const io::Json& meta) {
    const auto text = meta.dump();
    const auto bytes = std::as_bytes(std::span(text));
    return { bytes.begin(), bytes.end() };
}
struct Fixture {
    io::Json meta;
    io::Archive files;
    io::Bytes bundle() const {
        auto archive = files;
        archive["meta.json"] = json_bytes(meta);
        return io::zip(archive);
    }
};
// Known bytes are authored from the format, independently of SogFile::write.
Fixture fixture(int32_t version, uint32_t degree = 0, size_t palette_count = 1, uint32_t label = 0) {
    std::array<float, 256> scales {}, colors {}, sh;
    for (size_t i = 0; i < sh.size(); ++i) {
        sh[i] = float(i) / 16;
    }
    Fixture result { { { "version", version }, { "count", 4 },
                         { "means", { { "mins", { 0, 0, 0 } }, { "maxs", { 1, 1, 1 } }, { "files", { "means_l.webp", "means_u.webp" } } } },
                         { "scales", { { "codebook", scales }, { "files", { "scales.webp" } } } },
                         { "sh0", { { "codebook", colors }, { "files", { "sh0.webp" } } } } },
        {} };
    constexpr uint8_t ROTATIONS[4][3] { { 128, 128, 128 }, { 255, 128, 128 }, { 128, 1, 128 }, { 128, 128, 192 } };
    constexpr uint8_t OPACITIES[4] { 0, 102, 204, 255 };
    for (const auto name : { "means_l.webp", "means_u.webp", "scales.webp", "sh0.webp", "quats.webp" }) {
        io::Bytes pixels(4 * 4 * 4, std::byte { 0 });
        for (size_t i = 0; i < 4; ++i) {
            pixels[i * 4 + 3] = std::byte { 255 };
            if (std::string_view(name) == "quats.webp") {
                for (size_t c = 0; c < 3; ++c) {
                    pixels[i * 4 + c] = version == 3 ? static_cast<std::byte>(ROTATIONS[i][c]) : std::byte { 128 };
                }
                pixels[i * 4 + 3] = version == 3 ? std::byte { 255 } : std::byte { 252 };
            } else if (std::string_view(name) == "sh0.webp") {
                pixels[i * 4 + 3] = static_cast<std::byte>(OPACITIES[i]);
            }
        }
        result.files[name] = codec::encode_webp(pixels, 4, 4);
    }
    result.meta["quats"] = { { "files", { "quats.webp" } } };
    if (version == 1) {
        result.meta.erase("version");
        result.meta["means"]["shape"] = { 4, 3 };
        result.meta["quats"]["encoding"] = "quaternion_packed";
        result.meta["scales"]["mins"] = result.meta["scales"]["maxs"] = { 0, 0, 0 };
        result.meta["sh0"]["mins"] = { 0, 0, 0, -4 };
        result.meta["sh0"]["maxs"] = { 0, 0, 0, 4 };
    }
    if (degree) {
        const size_t coefficients = version == 1 ? 15 : splat::SH_COUNTS[degree] / 3;
        const auto width = static_cast<uint32_t>(64 * coefficients), height = static_cast<uint32_t>((palette_count + 63) / 64);
        io::Bytes centroids(size_t(width) * height * 4, std::byte { 255 });
        for (size_t j = 0; j < coefficients; ++j) {
            for (size_t c = 0; c < 3; ++c) {
                centroids[(label * coefficients + j) * 4 + c] = static_cast<std::byte>(j * 3 + c + 1);
            }
        }
        io::Bytes labels(4 * 4 * 4, std::byte { 255 });
        for (size_t i = 0; i < 4; ++i) {
            labels[i * 4] = static_cast<std::byte>(label & 255);
            labels[i * 4 + 1] = static_cast<std::byte>((label >> 8) & 255);
            labels[i * 4 + 2] = version == 3 ? static_cast<std::byte>((label >> 16) & 255) : std::byte { 255 };
        }
        result.files["shN_centroids.webp"] = codec::encode_webp(centroids, width, height);
        result.files["shN_labels.webp"] = codec::encode_webp(labels, 4, 4);
        result.meta["shN"] = { { "count", palette_count }, { "bands", degree }, { "codebook", sh }, { "files", { "shN_centroids.webp", "shN_labels.webp" } } };
        if (version == 1) {
            result.meta["shN"]["shape"] = { 4, splat::SH_COUNTS[degree] };
            result.meta["shN"]["mins"] = 0;
            result.meta["shN"]["maxs"] = 255.0f / 16;
        }
    }
    return result;
}
splat::Splat cloud(uint32_t degree = 0) {
    splat::Splat result(4, degree);
    for (size_t i = 0; i < result.size(); ++i) {
        auto& point = result.gaussians[i];
        point.mean = { float(i), -float(i), float(i) / 2 };
        point.scale.setConstant(0.125f);
        point.sh[0] = point.sh[1] = point.sh[2] = 0.5f;
        for (size_t c = 3; c < point.sh.size(); ++c) {
            point.sh[c] = 0.0625f;
        }
        point.opacity = std::array { 0.0f, 0.25f, 1.0f, 1.5625f }[i];
        point.rotation = i == 1 ? Eigen::Quaternionf(0, 1, 0, 0) : Eigen::Quaternionf::Identity();
    }
    return result;
}
void rotation_and_opacity() {
    auto data = cloud();
    require(codec::encode_exp_quaternion(data.gaussians[0].rotation) == std::array { std::byte { 128 }, std::byte { 128 }, std::byte { 128 } }, "Identity rotation must encode exactly");
    require(codec::encode_exp_quaternion(data.gaussians[1].rotation) == std::array { std::byte { 255 }, std::byte { 128 }, std::byte { 128 } }, "Half-turn rotation has wrong exp-map bytes");
    std::mt19937 random(370);
    std::normal_distribution<float> normal;
    for (size_t i = 0; i < 4096; ++i) {
        auto& rotation = data.gaussians[0].rotation;
        rotation = Eigen::Quaternionf(normal(random), normal(random), normal(random), normal(random));
        const auto bytes = codec::encode_exp_quaternion(data.gaussians[0].rotation);
        rotation.coeffs() *= -1;
        require(codec::encode_exp_quaternion(data.gaussians[0].rotation) == bytes, "Quaternion sign changed the exp map");
        data.gaussians[2].rotation = codec::decode_exp_quaternion(bytes);
        data.gaussians[2].rotation.normalize();
        require(data.gaussians[2].rotation.angularDistance(rotation.normalized()) < 0.023f, "Exp-map angular error exceeds 1.32 degrees");

        rotation.normalize();
        auto opposite = rotation;
        opposite.coeffs() *= -1;
        const auto packed = codec::encode_quaternion(rotation, true);
        require(codec::encode_quaternion(opposite, true) == packed, "Quaternion sign changed the packed encoding");
        require(codec::decode_quaternion(packed).normalized().angularDistance(rotation) < 0.025f, "Packed quaternion round trip changed rotation");
        const auto oct = codec::encode_oct_quaternion(rotation);
        require(codec::encode_oct_quaternion(opposite) == oct, "Quaternion sign changed the oct encoding");
        require(codec::decode_oct_quaternion(oct).normalized().angularDistance(rotation) < 0.025f, "Oct quaternion round trip changed rotation");
    }
    for (uint32_t i = 0; i < 256; ++i) {
        const auto value = static_cast<std::byte>(i);
        const float expected = float(i) * float(i) / (204 * 204);
        require(std::abs(codec::decode_sog_opacity(value) - expected) < 3e-7f, "Opacity does not follow the v3 square law");
        require(codec::encode_sog_opacity(expected) == value, "Opacity byte failed to round-trip");
    }
    require(codec::encode_sog_opacity(-1) == std::byte { 0 } && codec::encode_sog_opacity(2) == std::byte { 255 }, "Opacity saturation failed");
}
void readers(const std::filesystem::path& directory) {
    for (int32_t version : { 1, 2, 3 }) {
        for (uint32_t degree : { 0u, 1u, 2u, 3u }) {
            const auto source = fixture(version, degree);
            const auto bytes = source.bundle();
            const auto data = io::read_splat({ "fixture.sog", bytes });
            require(data.size() == 4 && data.sh_degree == degree, "SOG reader changed count or SH degree");
            const float opacity = version == 1 ? 1 / (1 + std::exp(-4.0f)) : version == 2 ? 1
                                                                                          : 1.5625f;
            require(std::abs(data.gaussians[3].opacity - opacity) < 1e-6f, "SOG opacity decoding differs from known bytes");
            require(data.gaussians[0].mean.isZero() && data.gaussians[0].scale == Eigen::Vector3f::Ones(), "SOG position or scale decoding changed");
            for (size_t c = 0; c < data.sh_count(); ++c) {
                require(data.gaussians[0].attribute(splat::ShOffset + c) == float(c + 1) / 16, "SOG SH palette channels are reordered");
            }
            const auto reduced = io::read_splat({ "fixture.sog", bytes, 0 });
            require(reduced.sh_degree == 0 && reduced.gaussians[0].sh.size() == 3, "SOG maxShDegree was ignored");
            if (version == 3) {
                require(data.gaussians[0].rotation.coeffs() == Eigen::Quaternionf::Identity().coeffs(), "V3 identity rotation did not decode exactly");
                require(data.gaussians[1].rotation.angularDistance(Eigen::Quaternionf(0, 1, 0, 0)) < 1e-6f, "V3 rotation RGB channels are reordered");
                require(data.gaussians[2].rotation.angularDistance(Eigen::Quaternionf(0, 0, -1, 0)) < 1e-6f, "V3 rotation green channel is ignored");
                const Eigen::Quaternionf expected(Eigen::AngleAxisf(std::numbers::pi_v<float> * 64 / 127, Eigen::Vector3f::UnitZ()));
                require(data.gaussians[3].rotation.angularDistance(expected) < 1e-6f, "V3 exp-map angle differs from known bytes");
            }
        }
    }
    for (const auto label : { 65536u, 262143u }) {
        const auto source = fixture(3, 3, label + 1, label);
        const auto bytes = source.bundle();
        const auto data = io::read_splat({ "wide.sog", bytes });
        require(data.gaussians[0].attribute(splat::ShOffset) == 1.0f / 16, "SOG v3 ignored the third label byte");
    }
    const auto source = fixture(3);
    for (const auto& [name, bytes] : source.files) {
        io::write_bytes(directory / name, bytes);
    }
    io::write_bytes(directory / "meta.json", json_bytes(source.meta));
    require(io::read_splat(directory / "meta.json").gaussians[3].opacity == 1.5625f, "Unpacked SOG v3 failed");
    io::Archive nested;
    nested["scene/meta.json"] = json_bytes(source.meta);
    for (const auto& [name, bytes] : source.files) {
        nested["scene/" + name] = bytes;
    }
    const auto bytes = io::zip(nested);
    require(io::read_splat({ "nested.zip", bytes }).size() == 4, "Nested SOG v3 ZIP resources failed");
}
void writers() {
    const auto source = cloud();
    constexpr std::array<uint32_t, 3> indices { 3, 1, 0 };
    for (int32_t version : { 2, 3 }) {
        const auto bytes = io::SogFile(version).write(source, indices);
        io::Resources resources("result.sog", bytes, ".sog");
        const auto& meta = resources.meta;
        require(meta.at("version") == version && meta.at("count") == indices.size(), "SOG writer lost version or subset count");
        require(meta.at("quats").at("files") == io::Json::array({ "quats.webp" }), "SOG must reference the quaternion texture");
        require(meta.contains("opacity") == (version == 3), "SOG opacity metadata has the wrong version");
        const auto colors = codec::decode_webp(resources.read("sh0.webp"));
        require(colors.rgba[3] == std::byte { 255 } && colors.rgba[11] == std::byte { 0 }, "Opacity endpoints were not preserved");
        if (version == 3) {
            const auto low = codec::decode_webp(resources.read("means_l.webp"));
            const auto high = codec::decode_webp(resources.read("means_u.webp"));
            const auto scales = codec::decode_webp(resources.read("scales.webp"));
            const auto quats = codec::decode_webp(resources.read("quats.webp"));
            require(quats.rgba[4] == std::byte { 255 } && quats.rgba[5] == std::byte { 128 } && quats.rgba[6] == std::byte { 128 }, "Exp-map bytes are not in quaternion RGB");
            for (size_t i = 0; i < indices.size(); ++i) {
                require(low.rgba[i * 4 + 3] == std::byte { 255 } && high.rgba[i * 4 + 3] == std::byte { 255 } &&
                            scales.rgba[i * 4 + 3] == std::byte { 255 } && quats.rgba[i * 4 + 3] == std::byte { 255 },
                    "SOG position, scale and rotation textures must have opaque alpha");
            }
            require(meta.at("opacity").at("max") == 1.5625f, "Opacity maximum is not the largest stored value");
        }
        const auto data = io::read_splat({ "result.sog", bytes });
        for (size_t i = 0; i < indices.size(); ++i) {
            require((data.gaussians[i].mean - source.gaussians[indices[i]].mean).norm() < 0.001f, "SOG writer changed the requested point order");
            require(data.gaussians[i].rotation.angularDistance(source.gaussians[indices[i]].rotation) < 0.04f, "SOG rotation error exceeded tolerance");
        }
        const auto empty = io::SogFile(version).write(splat::Splat(0, 3), {});
        require(io::read_splat({ "empty.sog", empty }).size() == 0, "Empty SOG failed to round-trip");
    }
    auto opaque = source;
    for (auto& point : opaque.gaussians) {
        point.opacity = 1;
    }
    const auto bytes = io::SogFile(3).write(opaque, indices);
    require(!io::Resources("opaque.sog", bytes, ".sog").meta.contains("opacity"), "Unity opacity should omit optional opacity.max");
}
void pipeline_options(const std::filesystem::path& directory) {
    pipeline::TaskContext context;
    context.set({ { "output", "source" } }, std::make_shared<splat::Splat>(cloud()));
    for (const auto extension : { ".sog", ".spz", ".uspz" }) {
        for (int32_t version : { -1, 0, 1, 2, 3, 4, 99 }) {
            const auto path = directory / ("options" + std::string(extension));
            io::Json config { { "input", "source" }, { "output", io::path_utf8(path) }, { "enableMortonSort", false } };
            if (version) {
                config["version"] = version;
            }
            config["compressLevel"] = std::string_view(extension) == ".sog" ? 100 : 1;
            pipeline::WriteTask().exec(config, context);
            auto bytes = io::read_bytes(path);
            if (std::string_view(extension) == ".sog") {
                require(io::Resources(path, bytes, ".sog").meta.at("version") == (version == 3 ? 3 : 2), "SOG version did not fall back to v2");
            } else {
                if (bytes[0] == std::byte { 0x1f }) {
                    bytes = codec::gunzip(bytes);
                }
                const auto expected = std::string_view(extension) == ".spz" && version == 4 ? 4u : 3u;
                require(io::ByteReader(bytes).read_at<uint32_t>(4) == expected, "SPZ version fallback or USPZ behavior changed");
            }
            require(io::read_splat(path).size() == 4, "Shared Write options produced an unreadable file");
        }
    }
}
void wide_palette_writer() {
    // Unique SH values keep one centroid per point, including labels above 65535.
    constexpr size_t COUNT = 65537;
    splat::Splat source(COUNT, 1);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& point = source.gaussians[i];
        point.scale.setOnes();
        point.rotation = Eigen::Quaternionf::Identity();
        point.opacity = 1;
        point.sh[0] = point.sh[1] = point.sh[2] = 0.5f;
        point.sh[3] = float(i & 63);
        point.sh[4] = float((i >> 6) & 63);
        point.sh[5] = float(i >> 12);
    }
    constexpr std::array<uint32_t, 2> indices { 65536, 0 };
    const auto bytes = io::SogFile(3, COUNT).write(source, indices);
    io::Resources resources("wide-output.sog", bytes, ".sog");
    require(resources.meta.at("shN").at("count") == COUNT, "SOG v3 palette was truncated to 65536");
    const auto labels = codec::decode_webp(resources.read("shN_labels.webp"));
    require(labels.rgba[0] == std::byte { 0 } && labels.rgba[1] == std::byte { 0 } && labels.rgba[2] == std::byte { 1 }, "SOG writer discarded the high SH label byte");
    const auto data = io::read_splat({ "wide-output.sog", bytes });
    require(data.size() == indices.size() && data.sh_degree == 1, "Wide SOG v3 palette failed to round-trip");
    for (size_t i = 0; i < data.size(); ++i) {
        for (size_t c = 3; c < 6; ++c) {
            require(std::abs(data.gaussians[i].sh[c] - source.gaussians[indices[i]].sh[c]) < 0.25f, "Wide SOG v3 palette decoded the wrong centroid");
        }
    }
}
void invalid_inputs() {
    const auto source = fixture(3, 3);
    for (const auto& modify : std::vector<std::function<void(Fixture&)>> {
             [](Fixture& f) { f.meta["version"] = 4; },
             [](Fixture& f) { f.meta["shN"]["bands"] = 4; },
             [](Fixture& f) { f.meta["count"] = 17; },
             [](Fixture& f) { f.meta["means"]["files"] = { "means_l.webp" }; },
             [](Fixture& f) { f.meta.erase("quats"); },
             [](Fixture& f) { f.meta["quats"]["files"] = io::Json::array(); },
             [](Fixture& f) { f.files["quats.webp"] = codec::encode_webp(io::Bytes(8 * 4 * 4), 8, 4); },
             [](Fixture& f) { f.meta["shN"]["count"] = 0; },
             [](Fixture& f) { f.meta["shN"]["count"] = 65; },
             [](Fixture& f) { f.files["scales.webp"] = codec::encode_webp(io::Bytes(8 * 4 * 4), 8, 4); } }) {
        auto broken = source;
        modify(broken);
        const auto bytes = broken.bundle();
        rejects([&] { io::read_splat({ "broken.sog", bytes, 0 }); });
    }
    auto nullable = fixture(3);
    nullable.meta["shN"] = nullptr;
    const auto bytes = nullable.bundle();
    require(io::read_splat({ "nullable.sog", bytes }).size() == 4, "Null optional SH palette should be absent");
}
void gpu_writers(const std::filesystem::path& directory) {
    gpu::select_device(0);
    for (uint32_t degree : { 1u, 2u, 3u }) {
        const auto source = cloud(degree);
        constexpr std::array<uint32_t, 4> indices { 3, 2, 1, 0 };
        for (int32_t version : { 2, 3 }) {
            const auto bytes = io::SogFile(version, version == 3 ? 262144 : 65536).write(source, indices);
            const auto data = io::read_splat({ "sh.sog", bytes });
            require(data.sh_degree == degree, "SOG writer lost SH bands");
            require(io::Resources("sh.sog", bytes, ".sog").meta.at("shN").at("count") == source.size(), "SOG palette count must describe the actual centroids");
            for (size_t i = 0; i < data.size(); ++i) {
                for (size_t c = 0; c < data.sh_count(); ++c) {
                    require(std::abs(data.gaussians[i].attribute(splat::ShOffset + c) - 0.0625f) < 1e-5f, "SOG SH export changed a constant coefficient");
                }
            }
            pipeline::TaskContext context;
            context.set({ { "output", "source" } }, std::make_shared<splat::Splat>(source));
            const auto path = directory / "palette.sog";
            pipeline::WriteTask().exec({ { "input", "source" }, { "output", io::path_utf8(path) }, { "version", version }, { "paletteSize", 2 } }, context);
            const auto pipeline_bytes = io::read_bytes(path);
            require(io::Resources(path, pipeline_bytes, ".sog").meta.at("shN").at("count") == 2, "Write did not forward paletteSize");
        }
    }
}
} // namespace
int main(int argc, char** argv) {
    gpu::DeviceGuard device_guard;
    const auto directory = std::filesystem::temp_directory_path() / ("sog-tests-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup { directory };
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--gpu") {
            gpu_writers(directory);
            wide_palette_writer();
        } else {
            rotation_and_opacity();
            readers(directory);
            writers();
            pipeline_options(directory);
            invalid_inputs();
        }
        std::cout << "SOG format contracts passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
