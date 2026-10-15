#include <cmath>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <io/file.h>
#include <io/spz.h>

namespace splat_transform::io {
namespace {
constexpr uint32_t SPZ_MAGIC = 0x5053474e;
constexpr float COLOR_SCALE = splat::SH_C0 / 0.15f;
} // namespace
splat::Splat SpzFile::read(const FileInput& source) const {
    auto input = source.bytes;
    Bytes decompressed;
    if (input.size() >= 2 && input[0] == 0x1f && input[1] == 0x8b) {
        decompressed = codec::gunzip(input);
        input = decompressed;
    }
    ByteReader header(input);
    if (header.read<uint32_t>() != SPZ_MAGIC) {
        throw std::runtime_error("Invalid SPZ magic");
    }
    const auto version = header.read<uint32_t>();
    if (version < 1 || version > 4) {
        throw std::runtime_error("Unsupported SPZ version");
    }
    const auto count = header.read<uint32_t>();
    const auto degree = header.read<uint8_t>();
    const auto fractional_bits = header.read<uint8_t>();
    header.read<uint8_t>();
    const auto streams = header.read<uint8_t>();
    if (fractional_bits > 30) {
        throw std::runtime_error("Invalid SPZ fractional bits");
    }
    splat::Splat result(count, source.retained_degree(degree));
    const auto source_sh_count = splat::SH_COUNTS.at(degree);
    Bytes attributes;
    std::span<const uint8_t> payload;
    if (version == 4) {
        const auto toc_offset = header.read<uint32_t>();
        if (toc_offset < 32 || toc_offset > input.size()) {
            throw std::runtime_error("Invalid SPZ TOC");
        }
        ByteReader reader(input.subspan(toc_offset));
        std::vector<size_t> expected { size_t(count) * 9, count, size_t(count) * 3, size_t(count) * 3, size_t(count) * 4 };
        if (degree) {
            expected.push_back(size_t(count) * source_sh_count);
        }
        if (streams != expected.size()) {
            throw std::runtime_error("Invalid SPZ stream count");
        }
        std::vector<uint64_t> compressed_sizes;
        for (size_t i = 0; i < streams; ++i) {
            compressed_sizes.push_back(reader.read<uint64_t>());
            if (reader.read<uint64_t>() != expected[i]) {
                throw std::runtime_error("Invalid SPZ stream size");
            }
        }
        for (size_t i = 0; i < streams; ++i) {
            if (compressed_sizes[i] > reader.remaining()) {
                throw std::runtime_error("Truncated SPZ stream");
            }
            auto chunk = codec::zstd_decompress(reader.take(static_cast<size_t>(compressed_sizes[i])));
            if (chunk.size() != expected[i]) {
                throw std::runtime_error("SPZ decompressed size mismatch");
            }
            attributes.insert(attributes.end(), chunk.begin(), chunk.end());
        }
        payload = attributes;
    } else {
        payload = input.subspan(16);
    }
    ByteReader reader(payload);
    const float fraction = std::ldexp(1.0f, -int(fractional_bits));
    for (size_t i = 0; i < count; ++i) {
        for (size_t axis = 0; axis < 3; ++axis) {
            if (version == 1) {
                result.gaussians[i].attribute(axis) = from_half(reader.read<uint16_t>());
            } else {
                auto bytes = reader.take(3);
                uint32_t bits = bytes[0] | (uint32_t(bytes[1]) << 8) | (uint32_t(bytes[2]) << 16);
                int32_t value = int32_t(bits) - ((bits & 0x800000) ? 0x1000000 : 0);
                result.gaussians[i].attribute(axis) = static_cast<float>(value * fraction);
            }
        }
    }
    for (size_t i = 0; i < count; ++i) {
        result.gaussians[i].attribute(splat::Alpha) = static_cast<float>(reader.read<uint8_t>() / 255.0f);
    }
    for (size_t i = 0; i < count; ++i) {
        for (size_t c = 0; c < 3; ++c) {
            result.gaussians[i].attribute(splat::Red + c) = ((reader.read<uint8_t>() / 255.0f - 0.5f) * COLOR_SCALE + 0.5f);
        }
    }
    for (size_t i = 0; i < count; ++i) {
        for (size_t c = 0; c < 3; ++c) {
            result.gaussians[i].attribute(splat::ScaleX + c) = std::exp(reader.read<uint8_t>() / 16.0f - 10);
        }
    }
    for (size_t i = 0; i < count; ++i) {
        auto& quaternion = result.gaussians[i].rotation;
        auto& rotation = quaternion.coeffs();
        if (version < 3) {
            float sum = 0;
            for (size_t c = 0; c < 3; ++c) {
                rotation[c] = reader.read<uint8_t>() / 127.5f - 1;
                sum += rotation[c] * rotation[c];
            }
            rotation[3] = std::sqrt(std::max(0.0f, 1 - sum));
        } else {
            auto packed = reader.read<uint32_t>();
            auto largest = packed >> 30;
            float sum = 0;
            for (int c = 3; c >= 0; --c) {
                if (uint32_t(c) == largest) {
                    continue;
                }
                auto magnitude = packed & 0x1ff;
                auto sign = (packed >> 9) & 1;
                packed >>= 10;
                rotation[c] = std::sqrt(0.5f) * (float(magnitude) / 511) * (sign ? -1 : 1);
                sum += rotation[c] * rotation[c];
            }
            rotation[largest] = std::sqrt(std::max(0.0f, 1 - sum));
        }
        quaternion.normalize();
    }
    for (size_t i = 0; i < count; ++i) {
        for (size_t c = 0; c < source_sh_count; ++c) {
            const auto value = (int(reader.read<uint8_t>()) - 128) / 128.0f;
            if (c < result.sh_count()) {
                result.gaussians[i].sh[c + 3] = value;
            }
        }
    }
    return result;
}
Bytes SpzFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    const auto version = version_;
    const auto level = compression_level_;
    if (version != 3 && version != 4) {
        throw std::runtime_error("Unsupported SPZ output version");
    }
    std::vector<Bytes> chunks(data.sh_degree ? 6 : 5);
    for (uint32_t index : indices) {
        for (size_t c = 0; c < 3; ++c) {
            const auto v = static_cast<uint32_t>(static_cast<int32_t>(std::clamp(float(data.gaussians[index].attribute(c)) * 4096, -8388607.0f, 8388607.0f)));
            chunks[0].push_back(v & 255);
            chunks[0].push_back((v >> 8) & 255);
            chunks[0].push_back((v >> 16) & 255);
        }
        chunks[1].push_back(codec::quantize_byte(data.gaussians[index].attribute(splat::Alpha) * 255));
        for (size_t c = 0; c < 3; ++c) {
            chunks[2].push_back(codec::quantize_byte(((data.gaussians[index].attribute(splat::Red + c) - 0.5f) / COLOR_SCALE + 0.5f) * 255));
            chunks[3].push_back(codec::quantize_byte((std::log(data.gaussians[index].attribute(splat::ScaleX + c)) + 10) * 16));
        }
        const auto& rotation = data.gaussians[index].rotation.coeffs();
        unsigned largest = 0;
        for (unsigned c = 1; c < 4; ++c) {
            if (std::abs(rotation[c]) > std::abs(rotation[largest])) {
                largest = c;
            }
        }
        uint32_t packed = largest;
        for (unsigned c = 0; c < 4; ++c) {
            if (c == largest) {
                continue;
            }
            const uint32_t sign = (rotation[c] < 0) != (rotation[largest] < 0);
            const auto magnitude = static_cast<uint32_t>(std::floor(511 * (std::abs(rotation[c]) / std::sqrt(0.5f)) + 0.5f));
            packed = (packed << 10) | (sign << 9) | magnitude;
        }
        append(chunks[4], packed);
        for (size_t c = 0; c < data.sh_count(); ++c) {
            const float step = c < 9 ? 8 : 16;
            const float quantized = std::floor((std::floor(float(data.gaussians[index].attribute(splat::ShOffset + c)) * 128 + 0.5f) + 128 + step / 2) / step) * step;
            chunks[5].push_back(static_cast<uint8_t>(std::clamp(quantized, 0.0f, 255.0f)));
        }
    }
    Bytes output;
    append(output, SPZ_MAGIC);
    append(output, uint32_t(version));
    append(output, static_cast<uint32_t>(indices.size()));
    output.push_back(static_cast<uint8_t>(data.sh_degree));
    output.push_back(12);
    output.push_back(1);
    output.push_back(version == 4 ? static_cast<uint8_t>(chunks.size()) : 0);
    if (version == 4) {
        append(output, uint32_t(32));
        output.resize(32, 0);
        for (auto& chunk : chunks) {
            const auto uncompressed = chunk.size();
            chunk = codec::zstd_compress(chunk, level);
            append(output, uint64_t(chunk.size()));
            append(output, uint64_t(uncompressed));
        }
    }
    for (const auto& chunk : chunks) {
        output.insert(output.end(), chunk.begin(), chunk.end());
    }
    return version == 3 && level != -1 ? codec::gzip(output, level) : output;
}
} // namespace splat_transform::io
