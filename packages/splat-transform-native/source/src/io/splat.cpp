#include <cmath>
#include <functional>
#include <io/resource.h>
#include <io/splat.h>
#include <numeric>

namespace splat_transform::io {
splat::Splat SplatFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const auto& path = source.path;
    splat::Splat result(bytes.size() / 32, 0);
    ByteReader reader(bytes);
    for (size_t i = 0; i < result.size(); ++i) {
        for (size_t c = 0; c < 6; ++c) {
            result.gaussians[i].attribute(c) = reader.read<float>();
        }
        for (size_t c = 0; c < 4; ++c) {
            result.gaussians[i].attribute(c == 3 ? splat::Alpha : splat::Red + c) = static_cast<float>(reader.read<uint8_t>() / 255.0f);
        }
        for (size_t c = 0; c < 4; ++c) {
            result.gaussians[i].attribute(c == 0 ? splat::QuatW : splat::QuatX + c - 1) = (int(reader.read<uint8_t>()) - 128) / 128.0f;
        }
        result.normalize_rotation(i);
    }
    return result;
}
Bytes SplatFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    Bytes output;
    output.reserve(indices.size() * 32);
    for (auto index : indices) {
        for (size_t c = 0; c < 6; ++c) {
            append(output, data.gaussians[index].attribute(c));
        }
        for (size_t c = 0; c < 4; ++c) {
            output.push_back(static_cast<uint8_t>(std::clamp(std::floor(float(data.gaussians[index].attribute(c == 3 ? splat::Alpha : splat::Red + c)) * 255 + 0.5f), 0.0f, 255.0f)));
        }
        for (size_t c = 0; c < 4; ++c) {
            output.push_back(static_cast<uint8_t>(std::clamp(std::floor(float(data.gaussians[index].attribute(c == 0 ? splat::QuatW : splat::QuatX + c - 1)) * 128 + 128.5f), 0.0f, 255.0f)));
        }
    }
    return output;
}
} // namespace splat_transform::io
