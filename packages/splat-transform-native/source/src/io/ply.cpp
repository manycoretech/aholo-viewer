#include "stream_reader.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <io/file.h>
#include <io/ply.h>
#include <limits>
#include <map>
#include <sstream>
#include <utility/thread_pool.h>

namespace splat_transform::io {
namespace {
struct Property {
    std::string type;
    std::string name;
};
struct Element {
    std::string name;
    size_t count;
    std::vector<Property> properties;
};
constexpr size_t PLY_BUFFER_SIZE = 64 * 1024 * 1024;
struct Header {
    bool little = true;
    bool compressed = false;
    std::vector<Element> elements;
};
template<typename T, typename Reader>
T read_scalar(Reader& reader, const std::string& type, bool little) {
    if (type == "float") {
        return static_cast<T>(reader.template read<float>(little));
    }
    if (type == "double") {
        return static_cast<T>(reader.template read<double>(little));
    }
    if (type == "uchar") {
        return static_cast<T>(reader.template read<uint8_t>());
    }
    if (type == "char") {
        return static_cast<T>(reader.template read<int8_t>());
    }
    if (type == "ushort") {
        return static_cast<T>(reader.template read<uint16_t>(little));
    }
    if (type == "short") {
        return static_cast<T>(reader.template read<int16_t>(little));
    }
    if (type == "uint") {
        return static_cast<T>(reader.template read<uint32_t>(little));
    }
    if (type == "int") {
        return static_cast<T>(reader.template read<int32_t>(little));
    }
    throw std::runtime_error("Unsupported PLY property type: " + type);
}
const std::array<std::string, 14> FIELDS {
    "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_1", "rot_2", "rot_3", "rot_0", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"
};
// Resolve the common native-endian float layout once, then decode directly
// into canonical Gaussians without per-value type/name/attribute dispatch.
template<typename Reader>
void read_float_vertices(const Element& element, std::span<const int> bindings, Reader& reader, splat::Splat& result, size_t batch_bytes) {
    const size_t stride = element.properties.size() * sizeof(float);
    if (element.count > result.size() || !stride || element.count > reader.remaining() / stride) {
        throw std::runtime_error("Truncated PLY vertex data or element count mismatch");
    }
    constexpr size_t MISSING = std::numeric_limits<size_t>::max();
    std::array<size_t, splat::ShOffset + splat::SH_COUNTS.back()> offsets;
    offsets.fill(MISSING);
    for (size_t p = 0; p < bindings.size(); ++p) {
        if (bindings[p] >= 0 && size_t(bindings[p]) < result.attribute_count()) {
            offsets[size_t(bindings[p])] = p * sizeof(float);
        }
    }
    const auto decode = [&](std::span<const uint8_t> bytes, size_t first, size_t begin, size_t end) {
        for (size_t i = begin; i < end; ++i) {
            auto& gaussian = result.gaussians[first + i];
            const auto* row = bytes.data() + i * stride;
            const auto value = [&](size_t column) {
                float scalar;
                std::memcpy(&scalar, row + offsets[column], sizeof(scalar));
                return scalar;
            };
            auto* sh = gaussian.sh.data();
            for (size_t axis = 0; axis < 3; ++axis) {
                gaussian.mean[axis] = value(splat::X + axis);
                gaussian.scale[axis] = std::exp(value(splat::ScaleX + axis));
                sh[axis] = value(splat::Red + axis) * splat::SH_C0 + 0.5f;
            }
            for (size_t axis = 0; axis < 4; ++axis) {
                gaussian.rotation.coeffs()[axis] = value(splat::QuatX + axis);
            }
            gaussian.opacity = 1 / (1 + std::exp(-value(splat::Alpha)));
            for (size_t c = splat::ShOffset; c < result.attribute_count(); ++c) {
                if (offsets[c] != MISSING) {
                    sh[c - splat::ShOffset + 3] = value(c);
                }
            }
            gaussian.normalize_rotation();
        }
    };
    constexpr size_t MIN_PARALLEL_VERTICES = 65536;
    const size_t batch_rows = std::max(size_t(1), batch_bytes / stride);
    for (size_t first = 0; first < element.count;) {
        const size_t count = std::min(batch_rows, element.count - first);
        const auto bytes = reader.take(count * stride);
        if (count < MIN_PARALLEL_VERTICES) {
            decode(bytes, first, 0, count);
        } else {
            auto& pool = threading::default_pool();
            const size_t chunk = std::max(size_t(8192), (count + pool.thread_count() - 1) / pool.thread_count());
            threading::TaskGroup<void> pending(pool, pool.thread_count());
            for (size_t begin = 0; begin < count; begin += chunk) {
                pending.submit(decode, bytes, first, begin, std::min(count, begin + chunk));
            }
            for (size_t i = 0; i < pending.size(); ++i) {
                pending.get(i);
            }
        }
        first += count;
    }
}
bool next_line(std::istream& stream, std::string& line) {
    return bool(std::getline(stream, line)) && !stream.eof();
}
bool next_line(StreamReader& stream, std::string& line) {
    line.clear();
    for (;;) {
        const auto bytes = stream.read_some(1);
        if (bytes.empty()) {
            return false;
        }
        if (bytes[0] == '\n') {
            return true;
        }
        line.push_back(static_cast<char>(bytes[0]));
    }
}
template<typename Reader>
Header read_header(Reader& header) {
    std::string line;
    next_line(header, line);
    if (line != "ply" && line != "ply\r") {
        throw std::runtime_error("Invalid PLY magic");
    }
    Header result;
    auto& [little, compressed, elements] = result;
    bool terminated = false;
    while (next_line(header, line)) {
        if (line == "end_header" || line == "end_header\r") {
            terminated = true;
            break;
        }
        std::istringstream fields(line);
        std::string keyword;
        fields >> keyword;
        if (keyword == "format") {
            std::string format, version;
            fields >> format >> version;
            if (version != "1.0" || (format != "binary_little_endian" && format != "binary_big_endian")) {
                throw std::runtime_error("Unsupported PLY format");
            }
            little = format == "binary_little_endian";
        } else if (keyword == "element") {
            Element element;
            fields >> element.name >> element.count;
            compressed |= element.name == "chunk";
            elements.push_back(std::move(element));
        } else if (keyword == "property") {
            Property property;
            fields >> property.type >> property.name;
            if (elements.empty() || property.type == "list") {
                throw std::runtime_error("Unsupported PLY property");
            }
            elements.back().properties.push_back(std::move(property));
        }
    }
    if (!terminated) {
        throw std::runtime_error("Missing PLY header terminator");
    }
    return result;
}
template<typename Reader>
splat::Splat read_ply(const Header& header, Reader& reader, unsigned max_sh_degree, size_t batch_bytes) {
    const auto& [little, compressed, elements] = header;
    size_t count = 0, sh_count = 0;
    for (const auto& element : elements) {
        if (element.name == "vertex") {
            count = element.count;
        }
        if (element.name == (compressed ? "sh" : "vertex")) {
            for (const auto& property : element.properties) {
                if (property.name.starts_with("f_rest_")) {
                    sh_count = std::max(sh_count, size_t(std::stoul(property.name.substr(7))) + 1);
                }
            }
        }
    }
    auto degree_it = std::find(splat::SH_COUNTS.begin(), splat::SH_COUNTS.end(), sh_count);
    if (degree_it == splat::SH_COUNTS.end()) {
        throw std::runtime_error("Unsupported PLY ShCoefficients coefficient count");
    }
    splat::Splat result(count, std::min(max_sh_degree, static_cast<unsigned>(degree_it - splat::SH_COUNTS.begin())));
    std::vector<std::map<std::string, float>> chunks;
    for (const auto& element : elements) {
        std::vector<int> bindings;
        for (const auto& property : element.properties) {
            auto found = std::find(FIELDS.begin(), FIELDS.end(), property.name);
            int column = found == FIELDS.end() ? -1 : static_cast<int>(found - FIELDS.begin());
            if (property.name.starts_with("f_rest_") && sh_count) {
                size_t original = std::stoul(property.name.substr(7));
                column = static_cast<int>(splat::ShOffset + (original % (sh_count / 3)) * 3 + original / (sh_count / 3));
            }
            bindings.push_back(column);
        }
        if (!compressed && element.name == "vertex") {
            for (int c = 0; c < 14; ++c) {
                if (std::find(bindings.begin(), bindings.end(), c) == bindings.end()) {
                    throw std::runtime_error("Missing PLY property: " + FIELDS[c]);
                }
            }
            if (little == (std::endian::native == std::endian::little) &&
                std::ranges::all_of(element.properties, [](const auto& property) { return property.type == "float"; })) {
                read_float_vertices(element, bindings, reader, result, batch_bytes);
                continue;
            }
        }
        for (size_t i = 0; i < element.count; ++i) {
            std::array<uint32_t, 4> packed {};
            std::map<std::string, float> chunk;
            for (size_t p = 0; p < element.properties.size(); ++p) {
                const auto& property = element.properties[p];
                if (compressed && element.name == "vertex") {
                    const auto value = read_scalar<uint32_t>(reader, property.type, little);
                    if (property.name == "packed_position") {
                        packed[0] = value;
                    }
                    if (property.name == "packed_rotation") {
                        packed[1] = value;
                    }
                    if (property.name == "packed_scale") {
                        packed[2] = value;
                    }
                    if (property.name == "packed_color") {
                        packed[3] = value;
                    }
                    continue;
                }
                float value = read_scalar<float>(reader, property.type, little);
                const int c = bindings[p];
                if (element.name == "chunk") {
                    chunk[property.name] = value;
                } else if ((element.name == "vertex" || element.name == "sh") && c >= 0) {
                    if (i >= result.size()) {
                        throw std::runtime_error("PLY element count mismatch");
                    }
                    if (compressed) {
                        value = value * 8 / 255 - 4;
                    } else if (c >= splat::ScaleX && c <= splat::ScaleZ) {
                        value = std::exp(value);
                    } else if (c >= splat::Red && c <= splat::Blue) {
                        value = value * splat::SH_C0 + 0.5f;
                    } else if (c == splat::Alpha) {
                        value = 1 / (1 + std::exp(-value));
                    }
                    if (static_cast<size_t>(c) < result.attribute_count()) {
                        result.gaussians[i].attribute(c) = value;
                    }
                }
            }
            if (element.name == "chunk") {
                chunks.push_back(std::move(chunk));
            } else if (compressed && element.name == "vertex") {
                const auto& limits = chunks.at(i >> 8);
                const std::array<std::string, 3> xyz { "x", "y", "z" }, rgb { "r", "g", "b" };
                for (size_t axis = 0; axis < 3; ++axis) {
                    const unsigned shift = axis == 0 ? 21 : axis == 1 ? 11
                                                                      : 0;
                    const unsigned mask = axis == 1 ? 1023 : 2047;
                    auto mix = [&](const std::string& field, float t) {
                        return limits.at("min_" + field) + t * (limits.at("max_" + field) - limits.at("min_" + field));
                    };
                    result.gaussians[i].attribute(splat::X + axis) = mix(xyz[axis], float((packed[0] >> shift) & mask) / mask);
                    result.gaussians[i].attribute(splat::ScaleX + axis) = std::exp(mix("scale_" + xyz[axis], float((packed[2] >> shift) & mask) / mask));
                    result.gaussians[i].attribute(splat::Red + axis) = mix(rgb[axis], float((packed[3] >> (24 - 8 * axis)) & 255) / 255);
                }
                const float a = (float((packed[1] >> 20) & 1023) / 1023 - 0.5f) * std::sqrt(2.0f);
                const float b = (float((packed[1] >> 10) & 1023) / 1023 - 0.5f) * std::sqrt(2.0f);
                const float c = (float(packed[1] & 1023) / 1023 - 0.5f) * std::sqrt(2.0f);
                const float d = std::sqrt(std::max(0.0f, 1 - a * a - b * b - c * c));
                const auto order = packed[1] >> 30;
                result.gaussians[i].attribute(splat::QuatX) = static_cast<float>(order == 0 ? a : order == 1 ? d
                                                                                                             : b);
                result.gaussians[i].attribute(splat::QuatY) = static_cast<float>(order <= 1 ? b : order == 2 ? d
                                                                                                             : c);
                result.gaussians[i].attribute(splat::QuatZ) = static_cast<float>(order <= 2 ? c : d);
                result.gaussians[i].attribute(splat::QuatW) = static_cast<float>(order == 0 ? d : a);
                result.gaussians[i].attribute(splat::Alpha) = float(packed[3] & 255) / 255;
            }
            if (element.name == "vertex") {
                result.normalize_rotation(i);
            }
        }
    }
    return result;
}
} // namespace
splat::Splat PlyFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    std::string_view text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    auto header_end = text.find("end_header\n");
    size_t terminator = 11;
    if (header_end == std::string_view::npos) {
        header_end = text.find("end_header\r\n");
        terminator = 12;
    }
    if (header_end == std::string_view::npos) {
        throw std::runtime_error("Missing PLY header terminator");
    }
    std::istringstream stream(std::string(text.substr(0, header_end + terminator)));
    const auto header = read_header(stream);
    ByteReader reader(bytes.subspan(header_end + terminator));
    return read_ply(header, reader, source.max_sh_degree, std::numeric_limits<size_t>::max());
}
splat::Splat PlyFile::read(const std::filesystem::path& path, unsigned max_sh_degree) const {
    StreamReader reader(path, PLY_BUFFER_SIZE);
    const auto header = read_header(reader);
    return read_ply(header, reader, max_sh_degree, PLY_BUFFER_SIZE);
}
Bytes PlyFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    std::ostringstream header;
    header << "ply\nformat binary_little_endian 1.0\ncomment Generated by EGS\nelement vertex " << indices.size() << '\n';
    for (const auto& field : FIELDS) {
        header << "property float " << field << '\n';
    }
    for (size_t i = 0; i < data.sh_count(); ++i) {
        header << "property float f_rest_" << i << '\n';
    }
    header << "end_header\n";
    auto text = header.str();
    Bytes output(text.begin(), text.end());
    output.reserve(output.size() + indices.size() * data.attribute_count() * 4);
    for (uint32_t index : indices) {
        for (size_t c = 0; c < 14; ++c) {
            float value = data.gaussians[index].attribute(c);
            if (c >= splat::ScaleX && c <= splat::ScaleZ) {
                value = std::log(value);
            }
            if (c >= splat::Red && c <= splat::Blue) {
                value = (value - 0.5f) / splat::SH_C0;
            }
            if (c == splat::Alpha) {
                value = value == 0 ? -100 : -std::log(1 / value - 1);
            }
            append(output, value);
        }
        const size_t coefficients = data.sh_count() / 3;
        for (size_t c = 0; c < data.sh_count(); ++c) {
            append(output, data.gaussians[index].attribute(splat::ShOffset + (c % coefficients) * 3 + c / coefficients));
        }
    }
    return output;
}
} // namespace splat_transform::io
