#include <codec/codec.h>
#include <codec/quantization.h>
#include <io/esz.h>
#include <io/file.h>
#include <utility/logger.h>

namespace splat_transform::io {
namespace {
constexpr uint32_t ESZ_MAGIC = 0x262834;
constexpr float COLOR_SCALE = splat::SH_C0 / 0.15f;
Bytes segment(ByteReader& reader, bool image) {
    const auto length = reader.read<uint32_t>();
    const auto content = reader.take(length);
    if (image) {
        return codec::decode_webp(content).rgba;
    }
    return Bytes(content.begin(), content.end());
}
void append_segment(Bytes& output, std::span<const uint8_t> bytes) {
    if (bytes.size() > UINT32_MAX) {
        throw std::runtime_error("ESZ segment exceeds 32-bit length");
    }
    append(output, static_cast<uint32_t>(bytes.size()));
    output.insert(output.end(), bytes.begin(), bytes.end());
}
void require_size(const Bytes& bytes, size_t expected, bool exact = false) {
    if (bytes.size() < expected || (exact && bytes.size() != expected)) {
        throw std::runtime_error("Invalid ESZ segment size");
    }
}
} // namespace
splat::Splat EszFile::read(const FileInput& source) const {
    auto input = source.bytes;
    const auto unpacked = codec::zstd_decompress(input);
    ByteReader reader(unpacked);
    if (reader.read<uint32_t>() != ESZ_MAGIC) {
        throw std::runtime_error("Invalid ESZ magic");
    }
    const auto meta_bytes = reader.take(reader.read<uint32_t>());
    const auto meta = Json::parse(meta_bytes.begin(), meta_bytes.end());
    if (meta.at("version") != 2) {
        throw std::runtime_error("Unsupported ESZ version");
    }
    const auto layout = meta.at("layout").get<std::string>();
    const auto degree = meta.at("shDegree").get<unsigned>();
    splat::Splat output(meta.at("counts").get<size_t>(), source.retained_degree(degree));
    const auto source_sh_count = splat::SH_COUNTS.at(degree);
    if (layout == "low") {
        const auto low = segment(reader, true), high = segment(reader, true);
        require_size(low, output.size() * 4);
        require_size(high, output.size() * 4);
        for (size_t c = 0; c < 3; ++c) {
            const float min = codec::signed_log(meta.at("box").at("min").at(c).get<float>());
            const float max = codec::signed_log(meta.at("box").at("max").at(c).get<float>());
            for (size_t i = 0; i < output.size(); ++i) {
                const auto value = low[i * 4 + c] | (uint32_t(high[i * 4 + c]) << 8);
                output.gaussians[i].attribute(c) = codec::signed_exp(min + (max - min) / 65535 * value);
            }
        }
        auto scales = segment(reader, true);
        require_size(scales, output.size() * 4);
        for (size_t i = 0; i < output.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                output.gaussians[i].attribute(splat::ScaleX + c) = std::exp(scales[i * 4 + c] / 16.0f - 10);
            }
        }
        auto quaternions = segment(reader, true);
        require_size(quaternions, output.size() * 4);
        for (size_t i = 0; i < output.size(); ++i) {
            codec::decode_quaternion(std::span(quaternions).subspan(i * 4, 4), output, i);
        }
        auto colors = segment(reader, true);
        require_size(colors, output.size() * 4);
        for (size_t i = 0; i < output.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                output.gaussians[i].attribute(splat::Red + c) = ((colors[i * 4 + c] / 255.0f - 0.5f) * COLOR_SCALE + 0.5f);
            }
            output.gaussians[i].attribute(splat::Alpha) = static_cast<float>(colors[i * 4 + 3] / 255.0f);
        }
        if (degree) {
            auto sh = segment(reader, true);
            const size_t coefficients = source_sh_count / 3;
            require_size(sh, output.size() * coefficients * 4);
            for (size_t i = 0; i < output.size(); ++i) {
                for (size_t j = 0; j < output.sh_count() / 3; ++j) {
                    for (size_t c = 0; c < 3; ++c) {
                        output.gaussians[i].attribute(splat::ShOffset + j * 3 + c) = (int(sh[(i * coefficients + j) * 4 + c]) - 128) / 128.0f;
                    }
                }
            }
        }
    } else if (layout == "high") {
        auto first = segment(reader, false);
        require_size(first, output.size() * 16, true);
        ByteReader centers(first);
        for (size_t i = 0; i < output.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                output.gaussians[i].attribute(c) = centers.read<float>();
            }
            output.gaussians[i].attribute(splat::Alpha) = from_half(centers.read<uint16_t>());
            centers.take(2);
        }
        auto second = segment(reader, false);
        require_size(second, output.size() * 16, true);
        ByteReader attributes(second);
        for (size_t i = 0; i < output.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                output.gaussians[i].attribute(splat::Red + c) = from_half(attributes.read<uint16_t>());
            }
            for (size_t c = 0; c < 3; ++c) {
                output.gaussians[i].attribute(splat::ScaleX + c) = std::exp(from_half(attributes.read<uint16_t>()));
            }
            codec::decode_oct_quaternion(attributes.read<uint32_t>(), output, i);
        }
        for (size_t group = 0; group < source_sh_count / 3; group += 4) {
            auto bytes = segment(reader, false);
            require_size(bytes, output.size() * 16, true);
            ByteReader sh(bytes);
            for (size_t i = 0; i < output.size(); ++i) {
                for (size_t j = 0; j < 4; ++j) {
                    const auto value = sh.read<uint32_t>();
                    if (group + j >= output.sh_count() / 3) {
                        continue;
                    }
                    const size_t col = splat::ShOffset + (group + j) * 3;
                    output.gaussians[i].attribute(col) = static_cast<float>(((value >> 21) & 2047) / 2047.0f * 2 - 1);
                    output.gaussians[i].attribute(col + 1) = static_cast<float>(((value >> 11) & 1023) / 1023.0f * 2 - 1);
                    output.gaussians[i].attribute(col + 2) = static_cast<float>((value & 2047) / 2047.0f * 2 - 1);
                }
            }
        }
    } else {
        throw std::runtime_error("Unsupported ESZ layout");
    }
    return output;
}
Bytes EszFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    const auto high_precision = high_precision_;
    auto& logger = utility::logger();
    logger.info(high_precision ? "ESZ encoding high mode" : "ESZ encoding low mode");
    constexpr int LEVEL = 3;
    const auto bounds = splat::bounds(data);
    const Json meta { { "version", 2 }, { "layout", high_precision ? "high" : "low" }, { "counts", data.size() }, { "shDegree", data.sh_degree }, { "box", { { "min", bounds.min }, { "max", bounds.max } } } };
    const auto text = meta.dump();
    Bytes output;
    append(output, ESZ_MAGIC);
    append(output, static_cast<uint32_t>(text.size()));
    output.insert(output.end(), text.begin(), text.end());
    if (high_precision) {
        Bytes segment;
        segment.reserve(data.size() * 16);
        for (auto index : indices) {
            for (size_t c = 0; c < 3; ++c) {
                append(segment, data.gaussians[index].attribute(c));
            }
            append(segment, to_half(data.gaussians[index].attribute(splat::Alpha)));
            append(segment, uint16_t(0));
        }
        append_segment(output, segment);
        segment.clear();
        for (auto index : indices) {
            for (size_t c = 0; c < 3; ++c) {
                append(segment, to_half(data.gaussians[index].attribute(splat::Red + c)));
            }
            for (size_t c = 0; c < 3; ++c) {
                append(segment, to_half(std::log(float(data.gaussians[index].attribute(splat::ScaleX + c)))));
            }
            append(segment, codec::encode_oct_quaternion(data, index));
        }
        append_segment(output, segment);
        for (size_t group = 0; group < data.sh_count() / 3; group += 4) {
            segment.clear();
            for (auto index : indices) {
                for (size_t j = 0; j < 4; ++j) {
                    uint32_t value = 0;
                    if (group + j < data.sh_count() / 3) {
                        const auto col = splat::ShOffset + (group + j) * 3;
                        auto quantize = [&](size_t c, unsigned mask) {
                            return static_cast<uint32_t>(std::clamp((data.gaussians[index].attribute(col + c) * 0.5f + 0.5f) * mask, 0.0f, float(mask)));
                        };
                        value = (quantize(0, 2047) << 21) | (quantize(1, 1023) << 11) | quantize(2, 2047);
                    }
                    append(segment, value);
                }
            }
            append_segment(output, segment);
        }
    } else {
        const auto [width, height] = codec::texture_size(data.size());
        auto write_image = [&](const Bytes& bytes, uint32_t w, uint32_t h) {
            append_segment(output, codec::encode_webp(bytes, w, h));
        };
        auto means_time = logger.time("ESZ encoding means");
        Bytes low(size_t(width) * height * 4, 255), high(low.size(), 255);
        for (size_t c = 0; c < 3; ++c) {
            const float min = codec::signed_log(bounds.min[c]);
            const float max = codec::signed_log(bounds.max[c]);
            const float scale = 65535 / std::max(max - min, 1e-9f);
            for (size_t i = 0; i < indices.size(); ++i) {
                const auto value = static_cast<uint32_t>(std::clamp(std::floor((codec::signed_log(data.gaussians[indices[i]].attribute(c)) - min) * scale + 0.5f), 0.0f, 65535.0f));
                low[i * 4 + c] = value & 255;
                high[i * 4 + c] = (value >> 8) & 255;
            }
        }
        write_image(low, width, height);
        write_image(high, width, height);
        means_time.finish();
        auto scales_time = logger.time("ESZ encoding scales");
        Bytes pixels(low.size(), 255);
        for (size_t i = 0; i < indices.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                pixels[i * 4 + c] = codec::quantize_byte((std::log(float(data.gaussians[indices[i]].attribute(splat::ScaleX + c))) + 10) * 16);
            }
        }
        write_image(pixels, width, height);
        scales_time.finish();
        auto quats_time = logger.time("ESZ encoding quats");
        std::fill(pixels.begin(), pixels.end(), 0);
        for (size_t i = 0; i < indices.size(); ++i) {
            const auto quat = codec::encode_quaternion(data, indices[i], true);
            std::copy(quat.begin(), quat.end(), pixels.begin() + i * 4);
        }
        write_image(pixels, width, height);
        quats_time.finish();
        auto colors_time = logger.time("ESZ encoding sh0");
        std::fill(pixels.begin(), pixels.end(), 255);
        for (size_t i = 0; i < indices.size(); ++i) {
            for (size_t c = 0; c < 3; ++c) {
                pixels[i * 4 + c] = codec::quantize_byte(((data.gaussians[indices[i]].attribute(splat::Red + c) - 0.5f) / COLOR_SCALE + 0.5f) * 255);
            }
            pixels[i * 4 + 3] = codec::quantize_byte(float(data.gaussians[indices[i]].attribute(splat::Alpha)) * 255);
        }
        write_image(pixels, width, height);
        colors_time.finish();
        if (data.sh_degree) {
            auto sh_time = logger.time("ESZ encoding shN");
            const auto coefficients = data.sh_count() / 3;
            const auto [w, h] = codec::texture_size(data.size() * coefficients);
            pixels.assign(size_t(w) * h * 4, 255);
            for (size_t i = 0; i < indices.size(); ++i) {
                for (size_t j = 0; j < coefficients; ++j) {
                    const float step = j < 3 ? 8 : 16;
                    for (size_t c = 0; c < 3; ++c) {
                        const float value = std::floor((std::floor(float(data.gaussians[indices[i]].attribute(splat::ShOffset + j * 3 + c)) * 128 + 0.5f) + 128 + step / 2) / step) * step;
                        pixels[(i * coefficients + j) * 4 + c] = static_cast<uint8_t>(std::clamp(value, 0.0f, 255.0f));
                    }
                }
            }
            write_image(pixels, w, h);
        }
    }
    return codec::zstd_compress(output, LEVEL);
}
} // namespace splat_transform::io
