#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <io/ksplat.h>
#include <io/ply.h>
#include <iostream>
#include <numeric>
#include <pipeline/task.h>
#include <spatial/sh_rotation.h>
#include <splat/attribute_view.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
void coefficient_ownership() {
    for (size_t size : { 0u, 3u, 12u, 27u, 48u }) {
        splat::ShCoefficients original(size);
        for (size_t i = 0; i < size; ++i) {
            original[i] = float(i + 1);
        }
        auto copy = original;
        if (size) {
            copy[0] = -1;
            require(original[0] == 1, "SH copy aliases its source");
        }
        auto moved = std::move(original);
        require(original.size() == 0 && moved.size() == size, "SH move did not transfer ownership");
        for (size_t i = 0; i < size; ++i) {
            require(moved[i] == float(i + 1), "SH move corrupted coefficients");
        }
        moved.resize(3);
        moved.resize(48);
        for (size_t i = 0; i < 48; ++i) {
            require(moved[i] == (i < std::min(size, size_t(3)) ? float(i + 1) : 0.0f), "SH resize did not preserve/zero bands");
        }
        splat::ShCoefficients rgb(3);
        rgb[0] = 9;
        moved.swap(rgb);
        require(moved.size() == 3 && moved[0] == 9 && rgb.size() == 48, "Inline/heap SH swap failed");
        original = std::move(rgb);
        copy = original;
        require(original.size() == 48 && rgb.size() == 0 && copy.size() == 48, "SH assignment lost ownership");
    }
}
void context_ownership() {
    pipeline::TaskContext context;
    const io::Json input { { "input", "source" } };
    context.set({ { "output", "source" } }, std::make_shared<splat::Splat>(3, 3));
    auto* original = context.splat_ptr(input)->gaussians.data();
    auto* coefficients = original[0].sh.data();
    auto retained = context.take_splat({ { "input", "source" }, { "output", "copy" } });
    require(retained.gaussians.data() != original && context.splat_ptr(input)->size() == 3, "Retained task input was consumed");
    auto alias = context.splat_ptr(input);
    auto aliased = context.take_splat({ { "input", "source" }, { "output", "source" } });
    require(aliased.gaussians.data() != original && alias->size() == 3, "Aliased task input was consumed");
    alias.reset();
    context.begin_task(io::Json::array({ "source" }));
    auto consumed = context.take_splat({ { "input", "source" }, { "output", "result" } });
    require(consumed.gaussians.data() == original && consumed.gaussians[0].sh.data() == coefficients, "Released task input was copied");
    context.set({ { "output", "result" } }, std::make_shared<splat::Splat>(std::move(consumed)));
    context.finish_task();
    auto replacement = context.take_splat({ { "input", "result" }, { "output", "result" } });
    require(replacement.gaussians.data() == original, "Replacement task input was copied");
    const std::array<uint32_t, 2> indices { 0, 2 };
    auto* last_sh = replacement.gaussians[2].sh.data();
    auto selected = std::move(replacement).select(indices);
    require(selected.size() == 2 && selected.gaussians[1].sh.data() == last_sh, "Selection copied Gaussian storage");
    std::vector<splat::Splat> parts;
    parts.push_back(std::move(selected));
    parts.emplace_back(1, 1);
    auto combined = splat::combine(std::move(parts));
    require(combined.size() == 3 && combined.sh_degree == 3 && combined.gaussians[1].sh.data() == last_sh, "Combine copied SH storage");
    require(combined.block_offsets == std::vector<size_t> { 0, 2 } && combined.block_counts == std::vector<size_t> { 2, 1 }, "Combine lost input block metadata");
    for (size_t i = 12; i < combined.gaussians[2].sh.size(); ++i) {
        require(combined.gaussians[2].sh[i] == 0, "Combine did not zero additional SH bands");
    }
}
void native_rotation() {
    splat::Splat cloud(1, 1);
    auto& sh = cloud.gaussians[0].sh;
    for (size_t i = 0; i < sh.size(); ++i) {
        sh[i] = float(i + 1);
    }
    Eigen::Matrix3f rotation;
    rotation << 0, -1, 0, 1, 0, 0, 0, 0, 1;
    spatial::ShRotation(rotation).apply(sh);
    for (size_t c = 0; c < 3; ++c) {
        require(sh[c] == float(c + 1), "SH rotation changed DC color");
        require(sh[3 + c] == float(10 + c) && sh[6 + c] == float(7 + c) && sh[9 + c] == -float(4 + c), "SH rotation changed native coefficient/channel order");
    }
    const splat::AttributeView view(cloud, splat::ShOffset);
    require(&view[0] == &sh[3], "Attribute access created a copied column");
}
void gaussian_rotation() {
    splat::Gaussian gaussian;
    gaussian.normalize_rotation();
    require(gaussian.rotation.coeffs().isZero(), "Default rotation must remain zero");

    gaussian.rotation = Eigen::Quaternionf(4, 1, 2, 3);
    const auto& view = gaussian;
    for (size_t c = 0; c < 4; ++c) {
        require(view.attribute(splat::QuatX + c) == float(c + 1), "Rotation attributes changed xyzw order");
        gaussian.attribute(splat::QuatX + c) = -float(c + 1);
    }
    require(gaussian.rotation.x() == -1 && gaussian.rotation.y() == -2 && gaussian.rotation.z() == -3 && gaussian.rotation.w() == -4,
        "Rotation attribute writes do not update the quaternion");

    gaussian.rotation = Eigen::Quaternionf(-4, 3, 0, 0);
    gaussian.normalize_rotation();
    require(gaussian.rotation.coeffs().isApprox(Eigen::Vector4f(-0.6f, 0, 0, 0.8f)), "Rotation normalization lost unit length or canonical sign");
    gaussian.scale = Eigen::Vector3f(1, 2, 3);
    const auto covariance = gaussian.covariance();
    splat::Gaussian restored;
    restored.set_covariance(covariance);
    require(restored.covariance().isApprox(covariance, 1e-5f), "Quaternion covariance round trip changed geometry");
}
void formats() {
    splat::Splat source(7, 3);
    std::vector<uint32_t> indices(source.size());
    std::iota(indices.begin(), indices.end(), 0);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& gaussian = source.gaussians[i];
        gaussian.mean = Eigen::Vector3f(float(i), float(i) / 4, -float(i));
        gaussian.scale.setConstant(0.125f);
        gaussian.rotation.w() = 1;
        gaussian.opacity = 0.75f;
        for (size_t c = 0; c < gaussian.sh.size(); ++c) {
            gaussian.sh[c] = float(std::sin(i + c) / 4);
        }
    }
    for (const auto extension : { ".ply", ".spz", ".uspz", ".esz" }) {
        for (bool variant : { false, true }) {
            auto file = io::create_file(extension, { { "version", variant ? 4 : 3 }, { "highPrecision", variant } }, io::FileOperation::Write);
            const auto bytes = file->write(source, indices);
            const auto full = file->read({ {}, bytes, 3 });
            for (unsigned degree : { 0u, 1u, 2u }) {
                const auto limited = file->read({ {}, bytes, degree });
                require(limited.sh_degree == degree && limited.size() == source.size(), "Format ignored maxShDegree");
                for (size_t i = 0; i < limited.size(); ++i) {
                    require(limited.gaussians[i].sh.size() == splat::SH_COUNTS[degree] + 3, "Format allocated discarded SH bands");
                    for (size_t c = 0; c < limited.attribute_count(); ++c) {
                        require(limited.gaussians[i].attribute(c) == full.gaussians[i].attribute(c), "Limited SH decode changed retained attributes");
                    }
                }
            }
        }
    }
    bool rejected = false;
    try {
        io::KsplatFile().write(source, indices);
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    require(rejected, "Read-only format accepted a write");
    require(io::create_file(".PLY")->name() == "PLY", "Format registry is case sensitive");
    rejected = false;
    try {
        pipeline::create_task("not-a-task");
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    require(rejected, "Task registry accepted an unknown task");
}
void packed_ply_fields() {
    std::string header = "ply\nformat binary_little_endian 1.0\nelement chunk 1\n";
    io::Bytes payload;
    for (const auto* name : { "x", "y", "z", "scale_x", "scale_y", "scale_z", "r", "g", "b" }) {
        header += "property float min_" + std::string(name) + "\nproperty float max_" + name + '\n';
        io::append(payload, 0.0f);
        io::append(payload, 1.0f);
    }
    header += "element vertex 1\nproperty uint packed_position\nproperty uint packed_rotation\nproperty uint packed_scale\nproperty uint packed_color\nend_header\n";
    for (const uint32_t field : { 0xa5a5a5a5u, 0xe0080201u, 0x12345678u, 0x89abcdefu }) {
        io::append(payload, field);
    }
    io::Bytes bytes(header.begin(), header.end());
    bytes.insert(bytes.end(), payload.begin(), payload.end());
    const auto decoded = io::PlyFile().read({ {}, bytes, 0 });
    const auto& point = decoded.gaussians.at(0);
    require(point.mean.z() == float(0xa5a5a5a5u & 2047) / 2047, "Packed PLY position lost integer bits");
    require(point.opacity == 239.0f / 255 && point.sh[0] == 137.0f / 255 && point.sh[2] == 205.0f / 255, "Packed PLY color lost integer bits");
}
void float_ply_layouts() {
    const auto path = std::filesystem::temp_directory_path() / ("splat-ply-layouts-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".PLY");
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove(path, error);
        }
    } cleanup { path };
    const std::array<std::string, 14> fields {
        "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_1", "rot_2", "rot_3", "rot_0", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"
    };
    const auto make_file = [&](size_t count, unsigned degree, bool native_endian, bool mixed) {
        const bool little = native_endian == (std::endian::native == std::endian::little);
        std::string header = "ply\nformat binary_" + std::string(little ? "little" : "big") + "_endian 1.0\nelement vertex " + std::to_string(count) + '\n';
        // Deliberately reorder the fields and keep an unused property in every
        // record. The big-endian/mixed files exercise the generic decoder.
        std::vector<std::string> names(fields.rbegin(), fields.rend());
        for (size_t i = 0; i < splat::SH_COUNTS[degree]; ++i) {
            names.push_back("f_rest_" + std::to_string(i));
        }
        for (const auto& name : names) {
            header += "property " + std::string(mixed && name == "x" ? "double " : "float ") + name + '\n';
        }
        header += "property " + std::string(mixed ? "uchar" : "float") + " ignored\nend_header\n";
        io::Bytes bytes(header.begin(), header.end());
        const auto append_value = [&]<typename T>(T value) {
            auto data = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
            if (little != (std::endian::native == std::endian::little)) {
                std::ranges::reverse(data);
            }
            bytes.insert(bytes.end(), data.begin(), data.end());
        };
        for (size_t row = 0; row < count; ++row) {
            for (size_t c = 0; c < names.size(); ++c) {
                const float value = float(int((row * 7 + c * 11) % 97) - 48) / 32;
                if (mixed && names[c] == "x") {
                    append_value(double(value));
                } else {
                    append_value(value);
                }
            }
            if (mixed) {
                append_value(uint8_t(17));
            } else {
                append_value(17.0f);
            }
        }
        return bytes;
    };
    for (unsigned degree : { 0u, 1u, 2u, 3u }) {
        const size_t count = degree == 3 ? 65537 : 13;
        const auto fast_bytes = make_file(count, degree, true, false);
        const auto opposite = make_file(count, degree, false, false);
        const auto mixed = make_file(count, degree, true, true);
        for (unsigned retained : { 0u, degree }) {
            const auto fast = io::PlyFile().read({ {}, fast_bytes, retained });
            for (const auto* generic_bytes : { &fast_bytes, &opposite, &mixed }) {
                const auto generic = io::PlyFile().read({ {}, *generic_bytes, retained });
                io::write_bytes(path, *generic_bytes);
                const auto streamed = io::read_splat(path, retained);
                require(fast.size() == generic.size() && fast.sh_degree == generic.sh_degree, "Fast PLY layout changed shape");
                require(streamed.size() == fast.size() && streamed.sh_degree == fast.sh_degree, "Streamed PLY layout changed shape");
                for (size_t row = 0; row < count; ++row) {
                    for (size_t c = 0; c < fast.attribute_count(); ++c) {
                        require(fast.gaussians[row].attribute(c) == generic.gaussians[row].attribute(c), "Fast PLY decode differs from generic numeric conversion");
                        require(streamed.gaussians[row].attribute(c) == generic.gaussians[row].attribute(c), "Streamed PLY decode differs from memory input");
                    }
                }
            }
        }
        bool rejected = false;
        try {
            io::PlyFile().read({ {}, std::span(fast_bytes).first(fast_bytes.size() - 1), degree });
        } catch (const std::runtime_error&) {
            rejected = true;
        }
        require(rejected, "Fast PLY decoder accepted a truncated record");
        rejected = false;
        io::write_bytes(path, std::span(fast_bytes).first(fast_bytes.size() - 1));
        try {
            io::read_splat(path, degree);
        } catch (const std::runtime_error&) {
            rejected = true;
        }
        require(rejected, "Streamed PLY decoder accepted a truncated record");
    }
}
} // namespace
int main() {
    try {
        coefficient_ownership();
        context_ownership();
        native_rotation();
        gaussian_rotation();
        formats();
        packed_ply_fields();
        float_ply_layouts();
        std::cout << "Abstraction contracts passed; sizeof(Gaussian)=" << sizeof(splat::Gaussian) << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
