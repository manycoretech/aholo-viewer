#include <bit>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <io/resource.h>
#include <io/sog.h>
#include <spatial/clustering.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::io {
splat::Splat SogFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const auto& path = source.path;
    Resources resources(path, bytes, ".sog");
    const auto& meta = resources.meta;
    const int version = meta.value("version", 1);
    if (version != 1 && version != 2) {
        throw std::runtime_error("Unsupported SOG version");
    }
    size_t count;
    unsigned degree = 0;
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
            degree = static_cast<unsigned>(found - splat::SH_COUNTS.begin());
        }
    } else {
        count = meta.at("count").get<size_t>();
        if (has_sh) {
            degree = meta.at("shN").at("bands").get<unsigned>();
        }
    }
    splat::Splat output(count, source.retained_degree(degree));
    std::vector<codec::Image> images;
    for (const auto& group : { "means", "scales", "quats", "sh0", "shN" }) {
        if (!meta.contains(group)) {
            continue;
        }
        for (const auto& ref : meta.at(group).at("files")) {
            images.push_back(codec::decode_webp(resources.read(ref.get<std::string>())));
        }
    }
    if (images.size() != (has_sh ? 7 : 5)) {
        throw std::runtime_error("Invalid SOG texture count");
    }
    for (size_t texture = 0; texture < 5; ++texture) {
        if (images[texture].rgba.size() < count * 4) {
            throw std::runtime_error("SOG texture is too small");
        }
    }
    const auto& means = meta.at("means");
    const auto& scales = meta.at("scales");
    const auto& colors = meta.at("sh0");
    for (size_t i = 0; i < count; ++i) {
        for (size_t c = 0; c < 3; ++c) {
            const float min = means.at("mins").at(c).get<float>(), max = means.at("maxs").at(c).get<float>();
            const uint32_t value = images[0].rgba[i * 4 + c] | (uint32_t(images[1].rgba[i * 4 + c]) << 8);
            output.gaussians[i].attribute(c) = codec::signed_exp(min + (max - min) / 65535 * value);
            const auto scale = images[2].rgba[i * 4 + c];
            const auto color = images[4].rgba[i * 4 + c];
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
        codec::decode_quaternion(std::span(images[3].rgba).subspan(i * 4, 4), output, i);
        float opacity = images[4].rgba[i * 4 + 3] / 255.0f;
        if (version == 1) {
            opacity = 1 / (1 + std::exp(-(colors.at("mins").at(3).get<float>() + (colors.at("maxs").at(3).get<float>() - colors.at("mins").at(3).get<float>()) * opacity)));
        }
        output.gaussians[i].attribute(splat::Alpha) = opacity;
    }
    if (has_sh) {
        const auto& sh = meta.at("shN");
        const size_t coefficients = splat::SH_COUNTS.at(degree) / 3;
        if (images[6].rgba.size() < count * 4) {
            throw std::runtime_error("SOG label texture is too small");
        }
        for (size_t i = 0; i < count; ++i) {
            const size_t label = images[6].rgba[i * 4] | (uint32_t(images[6].rgba[i * 4 + 1]) << 8);
            const size_t offset = version == 1 ? ((label >> 6) * images[5].width + (label & 63) * 15) * 4 : label * coefficients * 4;
            if (offset > images[5].rgba.size() || coefficients * 4 > images[5].rgba.size() - offset) {
                throw std::runtime_error("Invalid SOG label");
            }
            for (size_t j = 0; j < output.sh_count() / 3; ++j) {
                for (size_t c = 0; c < 3; ++c) {
                    const auto encoded = images[5].rgba[offset + j * 4 + c];
                    output.gaussians[i].attribute(splat::ShOffset + j * 3 + c) = static_cast<float>(version == 1 ? sh.at("mins").get<float>() + (sh.at("maxs").get<float>() - sh.at("mins").get<float>()) / 255 * encoded : sh.at("codebook").at(encoded).get<float>());
                }
            }
        }
    }
    return output;
}
Bytes SogFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    const auto [width, height] = codec::texture_size(data.size());
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
        const auto bounds = splat::bounds(data);
        Bytes low(image_size, 255), high(image_size, 255);
        for (size_t c = 0; c < 3; ++c) {
            const float min = codec::signed_log(bounds.min[c]), max = codec::signed_log(bounds.max[c]);
            result.metadata["means"]["mins"].push_back(min);
            result.metadata["means"]["maxs"].push_back(max);
            const float scale = 65535 / std::max(max - min, 1e-9f);
            for (size_t i = 0; i < indices.size(); ++i) {
                const auto value = static_cast<uint32_t>(std::clamp((codec::signed_log(data.gaussians[indices[i]].attribute(c)) - min) * scale, 0.0f, 65535.0f));
                low[i * 4 + c] = value & 255;
                high[i * 4 + c] = (value >> 8) & 255;
            }
        }
        result.files["means_l.webp"] = codec::encode_webp(low, width, height);
        result.files["means_u.webp"] = codec::encode_webp(high, width, height);
        result.metadata["means"]["files"] = { "means_l.webp", "means_u.webp" };
        return result;
    });
    textures.submit([&data, indices, width, height, image_size] {
        auto elapsed = utility::logger().time("SOG encoding quaternions");
        Bytes pixels(image_size, 0);
        for (size_t i = 0; i < indices.size(); ++i) {
            const auto q = codec::encode_quaternion(data, indices[i], false);
            std::ranges::copy(q, pixels.begin() + i * 4);
        }
        EncodedTextures result;
        result.files["quats.webp"] = codec::encode_webp(pixels, width, height);
        return result;
    });
    for (int group = 0; group < 2; ++group) {
        textures.submit([&data, indices, width, height, image_size, group] {
            auto elapsed = utility::logger().time(group == 0 ? "SOG encoding scales" : "SOG encoding colors");
            std::vector<splat::AttributeView> fields;
            for (size_t c = 0; c < 3; ++c) {
                fields.emplace_back(data, (group == 0 ? splat::ScaleX : splat::Red) + c);
            }
            const auto quantized = group == 0 ? spatial::quantize_1d(fields, [](float value) { return std::log(value); })
                                              : spatial::quantize_1d(fields, [](float value) { return (value - 0.5f) / splat::SH_C0; });
            Bytes pixels(image_size, 0);
            for (size_t i = 0; i < indices.size(); ++i) {
                for (size_t c = 0; c < 3; ++c) {
                    pixels[i * 4 + c] = quantized.labels(indices[i], c);
                }
                pixels[i * 4 + 3] = group == 0 ? 255 : static_cast<uint8_t>(std::clamp(float(data.gaussians[indices[i]].attribute(splat::Alpha)) * 255, 0.0f, 255.0f));
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
    Json meta { { "version", 2 }, { "count", data.size() }, { "means", Json::object() }, { "scales", Json::object() },
        { "quats", { { "files", { "quats.webp" } } } }, { "sh0", Json::object() } };
    const auto attribute_textures = textures.size();
    if (data.sh_degree && data.size()) {
        auto& logger = utility::logger();
        const auto sh_name = "SH" + std::to_string(data.sh_degree);
        auto elapsed = logger.time("SOG encoding " + sh_name);
        const size_t coefficients = data.sh_count() / 3;
        const size_t palette_size = std::clamp(std::bit_floor(data.size()), size_t { 1 }, size_t { 65536 });
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
        Bytes centroids(size_t(texture_width) * texture_height * 4, 255);
        for (size_t i = 0; i < centroid_count; ++i) {
            for (size_t j = 0; j < coefficients; ++j) {
                for (size_t c = 0; c < 3; ++c) {
                    centroids[(i * coefficients + j) * 4 + c] = quantized.labels(i, c * coefficients + j);
                }
            }
        }
        encode_image("shN_centroids.webp", std::move(centroids), texture_width, texture_height);
        Bytes pixels(image_size, 255);
        for (size_t i = 0; i < indices.size(); ++i) {
            const auto label = clustering.labels[indices[i]];
            pixels[i * 4] = label & 255;
            pixels[i * 4 + 1] = (label >> 8) & 255;
        }
        encode_image("shN_labels.webp", std::move(pixels), width, height);
        meta["shN"] = { { "count", palette_size }, { "bands", data.sh_degree }, { "codebook", quantized.centroids }, { "files", { "shN_centroids.webp", "shN_labels.webp" } } };
        for (size_t i = attribute_textures; i < textures.size(); ++i) {
            files.merge(textures.get(i).files);
        }
    }
    for (size_t i = 0; i < attribute_textures; ++i) {
        auto part = textures.get(i);
        files.merge(part.files);
        meta.update(part.metadata);
    }
    const auto text = meta.dump();
    files["meta.json"] = Bytes(text.begin(), text.end());
    return zip(files);
}
} // namespace splat_transform::io
