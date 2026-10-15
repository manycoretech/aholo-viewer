#include <algorithm>
#include <cmath>
#include <io/file.h>
#include <io/ply.h>
#include <map>
#include <sstream>

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
template<typename T>
T read_scalar(ByteReader& reader, const std::string& type, bool little) {
    if (type == "float") {
        return static_cast<T>(reader.read<float>(little));
    }
    if (type == "double") {
        return static_cast<T>(reader.read<double>(little));
    }
    if (type == "uchar") {
        return static_cast<T>(reader.read<uint8_t>());
    }
    if (type == "char") {
        return static_cast<T>(reader.read<int8_t>());
    }
    if (type == "ushort") {
        return static_cast<T>(reader.read<uint16_t>(little));
    }
    if (type == "short") {
        return static_cast<T>(reader.read<int16_t>(little));
    }
    if (type == "uint") {
        return static_cast<T>(reader.read<uint32_t>(little));
    }
    if (type == "int") {
        return static_cast<T>(reader.read<int32_t>(little));
    }
    throw std::runtime_error("Unsupported PLY property type: " + type);
}
const std::array<std::string, 14> FIELDS {
    "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_1", "rot_2", "rot_3", "rot_0", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"
};
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
    std::istringstream header(std::string(text.substr(0, header_end)));
    std::string line;
    std::getline(header, line);
    if (line != "ply" && line != "ply\r") {
        throw std::runtime_error("Invalid PLY magic");
    }
    bool little = true, compressed = false;
    std::vector<Element> elements;
    while (std::getline(header, line)) {
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
    splat::Splat result(count, source.retained_degree(static_cast<unsigned>(degree_it - splat::SH_COUNTS.begin())));
    ByteReader reader(bytes.subspan(header_end + terminator));
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
