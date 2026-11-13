#include <bit>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <cstdint>
#include <io/resource.h>
#include <io/sog.h>
#include <spatial/clustering.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::io {
SogFile::SogFile(int32_t version, size_t palette_size) : version_(version == 3 ? 3 : 2), palette_size_(palette_size) {
    if (palette_size > (version_ == 3 ? 262144u : 65536u)) {
        throw std::runtime_error("SH palette size exceeds the SOG version's limit");
    }
}
splat::Splat SogFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const auto& path = source.path;
    Resources resources(path, bytes, ".sog");
    const auto& meta = resources.meta;
    const int32_t version = meta.value("version", 1);
    if (version != 1 && version != 2 && version != 3) {
        throw std::runtime_error("Unsupported SOG version");
    }
    size_t count;
    uint32_t degree = 0;
    const bool has_sh = meta.contains("shN") && !meta.at("shN").is_null();
    if (version == 1) {
        if (meta.at("quats").value("encoding", "") != "quaternion_packed") {
            throw std::runtime_error("Unsupported SOG quaternion encoding");
        }
        count = meta.at("means").at("shape").at(0).get<size_t>();
        if (has_sh) {
            const auto sh = meta.at("shN").at("shape").at(1).get<size_t>();
            const auto found = std::find(splat::SH_COUNTS.begin(), splat::SH_COUNTS.end(), sh);
            if (found == splat::SH_COUNTS.end()) {
                throw std::runtime_error("Unsupported SOG ShCoefficients shape");
            }
            degree = static_cast<uint32_t>(found - splat::SH_COUNTS.begin());
        }
    } else {
        count = meta.at("count").get<size_t>();
        if (has_sh) {
            degree = meta.at("shN").at("bands").get<uint32_t>();
        }
    }
    splat::Splat output(count, source.retained_degree(degree));
    std::array<codec::Image, 7> images;
    auto read_images = [&](const char* group, size_t first, size_t expected) {
        const auto& files = meta.at(group).at("files");
        if (!files.is_array() || files.size() != expected) {
            throw std::runtime_error("Invalid SOG texture count for " + std::string(group));
        }
        for (size_t i = 0; i < expected; ++i) {
            images[first + i] = codec::decode_webp(resources.read(files.at(i).get<std::string>()));
        }
    };
    read_images("means", 0, 2);
    read_images("scales", 2, 1);
    read_images("quats", 3, 1);
    read_images("sh0", 4, 1);
    if (has_sh) {
        read_images("shN", 5, 2);
    }
    for (size_t texture = 0; texture < images.size(); ++texture) {
        if (texture == 5 || (texture == 6 && !has_sh)) {
            continue;
        }
        const auto& image = images[texture];
        if (image.rgba.size() / 4 < count || image.width != images[0].width || image.height != images[0].height) {
            throw std::runtime_error("Invalid SOG texture dimensions");
        }
    }
    const auto& means = meta.at("means");
    const auto& scales = meta.at("scales");
    const auto& colors = meta.at("sh0");
    for (size_t i = 0; i < count; ++i) {
        for (size_t c = 0; c < 3; ++c) {
            const float min = means.at("mins").at(c).get<float>(), max = means.at("maxs").at(c).get<float>();
            const uint32_t value = std::to_integer<uint32_t>(images[0].rgba[i * 4 + c]) | (std::to_integer<uint32_t>(images[1].rgba[i * 4 + c]) << 8);
            output.gaussians[i].attribute(c) = codec::signed_exp(min + (max - min) / 65535 * value);
            const auto scale = std::to_integer<uint8_t>(images[2].rgba[i * 4 + c]);
            const auto color = std::to_integer<uint8_t>(images[4].rgba[i * 4 + c]);
            float decoded_scale, decoded_color;
            if (version == 1) {
                decoded_scale = scales.at("mins").at(c).get<float>() + (scales.at("maxs").at(c).get<float>() - scales.at("mins").at(c).get<float>()) / 255 * scale;
                decoded_color = colors.at("mins").at(c).get<float>() + (colors.at("maxs").at(c).get<float>() - colors.at("mins").at(c).get<float>()) / 255 * color;
            } else {
                decoded_scale = scales.at("codebook").at(scale).get<float>();
                decoded_color = colors.at("codebook").at(color).get<float>();
            }
            output.gaussians[i].attribute(splat::ScaleX + c) = std::exp(decoded_scale);
            output.gaussians[i].attribute(splat::Red + c) = (splat::SH_C0 * decoded_color + 0.5f);
        }
        if (version == 3) {
            output.gaussians[i].rotation = codec::decode_exp_quaternion(std::span(images[3].rgba).subspan(i * 4, 3));
        } else {
            output.gaussians[i].rotation = codec::decode_quaternion(std::span(images[3].rgba).subspan(i * 4, 4));
        }
        output.gaussians[i].rotation.normalize();
        const auto alpha = images[4].rgba[i * 4 + 3];
        float opacity = version == 3 ? codec::decode_sog_opacity(alpha) : std::to_integer<uint8_t>(alpha) / 255.0f;
        if (version == 1) {
            opacity = 1 / (1 + std::exp(-(colors.at("mins").at(3).get<float>() + (colors.at("maxs").at(3).get<float>() - colors.at("mins").at(3).get<float>()) * opacity)));
        }
        output.gaussians[i].attribute(splat::Alpha) = opacity;
    }
    if (has_sh) {
        const auto& sh = meta.at("shN");
        const size_t coefficients = splat::SH_COUNTS.at(degree) / 3;
        const size_t palette_count = version == 1 ? images[5].rgba.size() / (15 * 4) : sh.at("count").get<size_t>();
        if (!coefficients || images[5].width != 64 * (version == 1 ? 15 : coefficients) ||
            palette_count > images[5].rgba.size() / ((version == 1 ? 15 : coefficients) * 4) ||
            (version != 1 && palette_count > (version == 3 ? 262144u : 65536u))) {
            throw std::runtime_error("Invalid SOG SH palette dimensions");
        }
        for (size_t i = 0; i < count; ++i) {
            const size_t label = std::to_integer<uint32_t>(images[6].rgba[i * 4]) | (std::to_integer<uint32_t>(images[6].rgba[i * 4 + 1]) << 8) |
                                 (version == 3 ? std::to_integer<uint32_t>(images[6].rgba[i * 4 + 2]) << 16 : 0);
            const size_t offset = version == 1 ? ((label >> 6) * images[5].width + (label & 63) * 15) * 4 : label * coefficients * 4;
            if (label >= palette_count || offset > images[5].rgba.size() || coefficients * 4 > images[5].rgba.size() - offset) {
                throw std::runtime_error("Invalid SOG label");
            }
            for (size_t j = 0; j < output.sh_count() / 3; ++j) {
                for (size_t c = 0; c < 3; ++c) {
                    const auto encoded = std::to_integer<uint8_t>(images[5].rgba[offset + j * 4 + c]);
                    output.gaussians[i].attribute(splat::ShOffset + j * 3 + c) = static_cast<float>(version == 1 ? sh.at("mins").get<float>() + (sh.at("maxs").get<float>() - sh.at("mins").get<float>()) / 255 * encoded : sh.at("codebook").at(encoded).get<float>());
                }
            }
        }
    }
    return output;
}
Bytes SogFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    std::byte maximum_opacity {};
    bool opacity_above_one = false;
    for (const auto index : indices) {
        const auto& point = data.gaussians.at(index);
        if (version_ == 3) {
            maximum_opacity = std::max(maximum_opacity, codec::encode_sog_opacity(point.opacity));
        }
        opacity_above_one |= point.opacity > 1;
    }
    if (version_ == 2 && opacity_above_one) {
        utility::logger().warn("SOG v2 clamps opacity above 1; use version: 3 to preserve it");
    }
    const auto [width, height] = codec::texture_size(indices.size());
    const size_t image_size = size_t(width) * height * 4;
    struct EncodedTextures {
        Archive files;
        Json metadata = Json::object();
    };
    auto& pool = threading::default_pool();
    threading::TaskGroup<EncodedTextures> textures(pool, 6);
    textures.submit([&data, indices, width, height, image_size] {
        auto elapsed = utility::logger().time("SOG encoding means");
        EncodedTextures result;
        const auto bounds = splat::bounds(data, indices);
        Bytes low(image_size, std::byte { 255 }), high(image_size, std::byte { 255 });
        for (size_t c = 0; c < 3; ++c) {
            const float min = codec::signed_log(bounds.min()[c]), max = codec::signed_log(bounds.max()[c]);
            result.metadata["means"]["mins"].push_back(min);
            result.metadata["means"]["maxs"].push_back(max);
            const float scale = 65535 / std::max(max - min, 1e-9f);
            for (size_t i = 0; i < indices.size(); ++i) {
                const auto value = static_cast<uint32_t>(std::clamp((codec::signed_log(data.gaussians[indices[i]].attribute(c)) - min) * scale, 0.0f, 65535.0f));
                low[i * 4 + c] = static_cast<std::byte>(value & 255);
                high[i * 4 + c] = static_cast<std::byte>((value >> 8) & 255);
            }
        }
        result.files["means_l.webp"] = codec::encode_webp(low, width, height);
        result.files["means_u.webp"] = codec::encode_webp(high, width, height);
        result.metadata["means"]["files"] = { "means_l.webp", "means_u.webp" };
        return result;
    });
    textures.submit([this, &data, indices, width, height, image_size] {
        auto elapsed = utility::logger().time("SOG encoding quaternions");
        Bytes pixels(image_size);
        for (size_t i = 0; i < indices.size(); ++i) {
            if (version_ == 3) {
                const auto q = codec::encode_exp_quaternion(data.gaussians[indices[i]].rotation);
                std::ranges::copy(q, pixels.begin() + i * 4);
                pixels[i * 4 + 3] = std::byte { 255 };
            } else {
                const auto q = codec::encode_quaternion(data.gaussians[indices[i]].rotation, false);
                std::ranges::copy(q, pixels.begin() + i * 4);
            }
        }
        EncodedTextures result;
        result.files["quats.webp"] = codec::encode_webp(pixels, width, height);
        return result;
    });
    for (int32_t group = 0; group < 2; ++group) {
        textures.submit([this, &data, indices, width, height, image_size, group] {
            auto elapsed = utility::logger().time(group == 0 ? "SOG encoding scales" : "SOG encoding colors");
            std::vector<splat::AttributeView> fields;
            for (size_t c = 0; c < 3; ++c) {
                fields.emplace_back(data, (group == 0 ? splat::ScaleX : splat::Red) + c);
            }
            const auto quantized = group == 0 ? spatial::quantize_1d(fields, [](float value) { return std::log(value); })
                                              : spatial::quantize_1d(fields, [](float value) { return (value - 0.5f) / splat::SH_C0; });
            Bytes pixels(image_size);
            for (size_t i = 0; i < indices.size(); ++i) {
                for (size_t c = 0; c < 3; ++c) {
                    pixels[i * 4 + c] = static_cast<std::byte>(quantized.labels(indices[i], c));
                }
                if (group == 0) {
                    pixels[i * 4 + 3] = std::byte { 255 };
                } else {
                    const float opacity = data.gaussians[indices[i]].opacity;
                    pixels[i * 4 + 3] = version_ == 3 ? codec::encode_sog_opacity(opacity) : static_cast<std::byte>(std::clamp(opacity * 255, 0.0f, 255.0f));
                }
            }
            const std::string name = group == 0 ? "scales" : "sh0";
            EncodedTextures result;
            result.files[name + ".webp"] = codec::encode_webp(pixels, width, height);
            result.metadata[name] = { { "codebook", quantized.centroids }, { "files", { name + ".webp" } } };
            return result;
        });
    }
    auto encode_image = [&](std::string name, Bytes pixels, uint32_t image_width, uint32_t image_height) {
        textures.submit([name = std::move(name), pixels = std::move(pixels), image_width, image_height] {
            EncodedTextures result;
            result.files[name] = codec::encode_webp(pixels, image_width, image_height);
            return result;
        });
    };
    Archive files;
    // Preserve ordered_json's legacy key order while merging worker results.
    Json meta { { "version", version_ }, { "count", indices.size() }, { "means", Json::object() }, { "scales", Json::object() } };
    meta["quats"] = { { "files", { "quats.webp" } } };
    meta["sh0"] = Json::object();
    if (version_ == 3 && codec::decode_sog_opacity(maximum_opacity) > 1) {
        meta["opacity"] = { { "max", codec::decode_sog_opacity(maximum_opacity) } };
    }
    const auto attribute_textures = textures.size();
    if (data.sh_degree && !indices.empty()) {
        auto& logger = utility::logger();
        const auto sh_name = "SH" + std::to_string(data.sh_degree);
        auto elapsed = logger.time("SOG encoding " + sh_name);
        const size_t coefficients = data.sh_count() / 3;
        const size_t palette_size = palette_size_ ? std::min(palette_size_, data.size()) : std::clamp(std::bit_floor(data.size()), size_t { 1 }, size_t { 65536 });
        constexpr size_t ITERATIONS = 10;
        logger.info("SOG ", sh_name, " k-means with clusters=", palette_size, " iterations=", ITERATIONS);
        // Coordinate Vulkan work on the caller while CPU texture jobs use the
        // shared pool; no extra coordinator thread or per-SOG pool is needed.
        auto clustering_time = logger.time("SOG " + sh_name + " k-means");
        auto clustering = spatial::k_means(spatial::FeatureView(data), palette_size, ITERATIONS);
        clustering_time.finish();
        auto quantized = spatial::quantize_1d(clustering.centroids);
        const size_t centroid_count = static_cast<size_t>(clustering.centroids.rows());
        const auto texture_width = static_cast<uint32_t>(64 * coefficients);
        const auto texture_height = static_cast<uint32_t>((centroid_count + 63) / 64);
        Bytes centroids(size_t(texture_width) * texture_height * 4, std::byte { 255 });
        for (size_t i = 0; i < centroid_count; ++i) {
            for (size_t j = 0; j < coefficients; ++j) {
                for (size_t c = 0; c < 3; ++c) {
                    centroids[(i * coefficients + j) * 4 + c] = static_cast<std::byte>(quantized.labels(i, c * coefficients + j));
                }
            }
        }
        encode_image("shN_centroids.webp", std::move(centroids), texture_width, texture_height);
        Bytes pixels(image_size, std::byte { 255 });
        for (size_t i = 0; i < indices.size(); ++i) {
            const auto label = clustering.labels[indices[i]];
            pixels[i * 4] = static_cast<std::byte>(label & 255);
            pixels[i * 4 + 1] = static_cast<std::byte>((label >> 8) & 255);
            pixels[i * 4 + 2] = version_ == 3 ? static_cast<std::byte>((label >> 16) & 255) : std::byte { 0 };
        }
        encode_image("shN_labels.webp", std::move(pixels), width, height);
        meta["shN"] = { { "count", centroid_count }, { "bands", data.sh_degree }, { "codebook", quantized.centroids }, { "files", { "shN_centroids.webp", "shN_labels.webp" } } };
    }
    for (size_t i = attribute_textures; i < textures.size(); ++i) {
        files.merge(textures.get(i).files);
    }
    for (size_t i = 0; i < attribute_textures; ++i) {
        auto part = textures.get(i);
        files.merge(part.files);
        meta.update(part.metadata);
    }
    const auto text = meta.dump();
    const auto meta_bytes = std::as_bytes(std::span(text));
    files["meta.json"] = Bytes(meta_bytes.begin(), meta_bytes.end());
    return zip(files);
}
} // namespace splat_transform::io
