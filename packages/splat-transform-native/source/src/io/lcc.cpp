#include <cmath>
#include <io/lcc.h>
#include <io/resource.h>

namespace splat_transform::io {
splat::Splat LccFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const auto& path = source.path;
    Resources resources(path, bytes, ".lcc");
    const auto& meta = resources.meta;
    const auto index = resources.read("index.bin");
    const auto data_bytes = resources.read("data.bin");
    Bytes sh_bytes;
    bool has_sh = false;
    try {
        resources.resolve("shcoef.bin");
        has_sh = true;
    } catch (const std::runtime_error&) {
    }
    if (has_sh) {
        sh_bytes = resources.read("shcoef.bin");
    }
    const ByteReader index_reader(index), sh_reader(sh_bytes);
    splat::Splat result(meta.at("splats").at(0).get<size_t>(), source.retained_degree(has_sh ? 3 : 0));
    Json attributes = Json::object();
    for (const auto& attr : meta.at("attributes")) {
        attributes[attr.at("name").get<std::string>()] = attr;
    }
    const size_t levels = meta.at("totalLevel").get<size_t>();
    if (!levels) {
        throw std::runtime_error("Invalid LCC level count");
    }
    const size_t stride = 4 + 16 * levels;
    size_t output = 0;
    for (size_t offset = 0; offset + stride <= index.size(); offset += stride) {
        const auto points = index_reader.read_at<uint32_t>(offset + 4);
        const auto start = index_reader.read_at<uint64_t>(offset + 8);
        for (size_t i = 0; i < points; ++i, ++output) {
            if (output >= result.size()) {
                throw std::runtime_error("LCC point count mismatch");
            }
            const auto record_offset = static_cast<size_t>(start) + i * 32;
            if (record_offset > data_bytes.size() || 32 > data_bytes.size() - record_offset) {
                throw std::runtime_error("Truncated LCC record");
            }
            ByteReader reader(std::span(data_bytes).subspan(record_offset, 32));
            for (size_t c = 0; c < 3; ++c) {
                result.gaussians[output].attribute(c) = reader.read<float>();
            }
            for (size_t c = 0; c < 4; ++c) {
                result.gaussians[output].attribute(c == 3 ? splat::Alpha : splat::Red + c) = static_cast<float>(reader.read<uint8_t>() / 255.0f);
            }
            for (size_t c = 0; c < 3; ++c) {
                const float t = reader.read<uint16_t>() / 65535.0f;
                const auto& scale = attributes.at("scale");
                result.gaussians[output].attribute(splat::ScaleX + c) = ((1 - t) * scale.at("min").at(c).get<float>() + t * scale.at("max").at(c).get<float>());
            }
            auto packed = reader.read<uint32_t>();
            const auto largest = packed >> 30;
            std::array<float, 4> q {};
            float sum = 0;
            for (size_t c = 0, source = 0; c < 4; ++c) {
                if (c == largest) {
                    continue;
                }
                q[c] = ((packed >> (10 * source++)) & 1023) / 1023.0f * 1.414213562373095f - 0.7071067811865475f;
                sum += q[c] * q[c];
            }
            q[largest] = std::sqrt(std::max(0.0f, 1 - sum));
            for (size_t c = 0; c < 4; ++c) {
                result.gaussians[output].attribute(splat::QuatX + c) = static_cast<float>(q[c]);
            }
            result.normalize_rotation(output);
            for (size_t coefficient = 0; coefficient < result.sh_count() / 3; ++coefficient) {
                const auto packed_sh = sh_reader.read_at<uint32_t>(static_cast<size_t>(start) * 2 + i * 64 + coefficient * 4);
                const std::array<float, 3> v { (packed_sh & 2047) / 2047.0f, ((packed_sh >> 11) & 1023) / 1023.0f, ((packed_sh >> 21) & 2047) / 2047.0f };
                for (size_t c = 0; c < 3; ++c) {
                    const auto& attr = attributes.at("shcoef");
                    result.gaussians[output].attribute(splat::ShOffset + coefficient * 3 + c) = ((1 - v[c]) * attr.at("min").at(c).get<float>() + v[c] * attr.at("max").at(c).get<float>());
                }
            }
        }
    }
    if (output != result.size()) {
        throw std::runtime_error("LCC index count mismatch");
    }
    return result;
}
} // namespace splat_transform::io
