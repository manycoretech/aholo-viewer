#include "../codec/compression_stream.h"
#include "file_stream.h"
#include "stream_reader.h"
#include <cmath>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <io/file.h>
#include <io/spz.h>
#include <optional>

namespace splat_transform::io {
namespace {
constexpr uint32_t SPZ_MAGIC = 0x5053474e;
constexpr float COLOR_SCALE = splat::SH_C0 / 0.15f;
} // namespace
namespace {
void read_attribute(StreamReader& input, splat::Splat& result, unsigned degree, unsigned version, unsigned fractional_bits, size_t field) {
    const size_t sh_count = splat::SH_COUNTS.at(degree);
    const std::array<size_t, 6> strides { version == 1 ? 6u : 9u, 1, 3, 3, version < 3 ? 3u : 4u, sh_count };
    if (!strides[field]) {
        return;
    }
    if (field == 5 && !result.sh_count()) {
        input.skip(result.size() * sh_count);
        return;
    }
    const float fraction = std::ldexp(1.0f, -int(fractional_bits));
    decode_records(input, result.size(), strides[field], [&](std::span<const uint8_t> bytes, size_t first, size_t count) {
        ByteReader reader(bytes);
        for (size_t i = first; i < first + count; ++i) {
            auto& point = result.gaussians[i];
            if (field == 0) {
                for (size_t axis = 0; axis < 3; ++axis) {
                    if (version == 1) {
                        point.attribute(axis) = from_half(reader.read<uint16_t>());
                    } else {
                        const auto value = reader.take(3);
                        const uint32_t bits = value[0] | (uint32_t(value[1]) << 8) | (uint32_t(value[2]) << 16);
                        const int32_t scalar = int32_t(bits) - ((bits & 0x800000) ? 0x1000000 : 0);
                        point.attribute(axis) = static_cast<float>(scalar * fraction);
                    }
                }
            } else if (field == 1) {
                point.opacity = static_cast<float>(reader.read<uint8_t>() / 255.0f);
            } else if (field == 2) {
                for (size_t c = 0; c < 3; ++c) {
                    point.attribute(splat::Red + c) = ((reader.read<uint8_t>() / 255.0f - 0.5f) * COLOR_SCALE + 0.5f);
                }
            } else if (field == 3) {
                for (size_t c = 0; c < 3; ++c) {
                    point.scale[c] = std::exp(reader.read<uint8_t>() / 16.0f - 10);
                }
            } else if (field == 4) {
                auto& rotation = point.rotation.coeffs();
                float sum = 0;
                if (version < 3) {
                    for (size_t c = 0; c < 3; ++c) {
                        rotation[c] = reader.read<uint8_t>() / 127.5f - 1;
                        sum += rotation[c] * rotation[c];
                    }
                    rotation[3] = std::sqrt(std::max(0.0f, 1 - sum));
                } else {
                    auto packed = reader.read<uint32_t>();
                    const auto largest = packed >> 30;
                    for (int c = 3; c >= 0; --c) {
                        if (uint32_t(c) == largest) {
                            continue;
                        }
                        const auto magnitude = packed & 0x1ff;
                        const auto sign = (packed >> 9) & 1;
                        packed >>= 10;
                        rotation[c] = std::sqrt(0.5f) * (float(magnitude) / 511) * (sign ? -1 : 1);
                        sum += rotation[c] * rotation[c];
                    }
                    rotation[largest] = std::sqrt(std::max(0.0f, 1 - sum));
                }
                point.rotation.normalize();
            } else {
                for (size_t c = 0; c < sh_count; ++c) {
                    const auto value = (int(reader.read<uint8_t>()) - 128) / 128.0f;
                    if (c < result.sh_count()) {
                        point.sh[c + 3] = value;
                    }
                }
            }
        }
    });
}
splat::Splat read_spz_stream(StreamReader& source, unsigned max_sh_degree) {
    std::optional<StreamReader> decompressed;
    const auto signature = source.peek(2);
    if (signature[0] == 0x1f && signature[1] == 0x8b) {
        decompressed.emplace(gzip_reader(source));
    }
    auto& input = decompressed ? *decompressed : source;
    if (input.read<uint32_t>() != SPZ_MAGIC) {
        throw std::runtime_error("Invalid SPZ magic");
    }
    const auto version = input.read<uint32_t>();
    if (version < 1 || version > 4) {
        throw std::runtime_error("Invalid SPZ version");
    }
    const auto count = input.read<uint32_t>();
    const auto degree = input.read<uint8_t>();
    const auto fractional_bits = input.read<uint8_t>();
    input.read<uint8_t>();
    const auto streams = input.read<uint8_t>();
    if (degree > 3 || fractional_bits > 30) {
        throw std::runtime_error("Invalid SPZ SH degree or fractional bits");
    }
    splat::Splat result(count, std::min(unsigned(degree), max_sh_degree));
    if (version == 4) {
        const auto toc_offset = input.read<uint32_t>();
        if (toc_offset < 32 || streams != (degree ? 6 : 5)) {
            throw std::runtime_error("Invalid SPZ TOC");
        }
        input.skip(toc_offset - 20);
        const std::array<size_t, 6> expected { size_t(count) * 9, count, size_t(count) * 3, size_t(count) * 3, size_t(count) * 4, size_t(count) * splat::SH_COUNTS[degree] };
        std::array<size_t, 6> compressed_sizes {};
        for (size_t field = 0; field < streams; ++field) {
            const auto compressed = input.read<uint64_t>();
            if (compressed > std::numeric_limits<size_t>::max() || input.read<uint64_t>() != expected[field]) {
                throw std::runtime_error("Invalid SPZ stream size");
            }
            compressed_sizes[field] = static_cast<size_t>(compressed);
        }
        for (size_t field = 0; field < streams; ++field) {
            auto attributes = zstd_reader(input, compressed_sizes[field]);
            read_attribute(attributes, result, degree, version, fractional_bits, field);
            attributes.require_end();
        }
    } else {
        for (size_t field = 0; field < 6; ++field) {
            read_attribute(input, result, degree, version, fractional_bits, field);
        }
    }
    input.require_end();
    return result;
}
} // namespace
splat::Splat SpzFile::read(const FileInput& source) const {
    StreamReader reader(source.bytes);
    return read_spz_stream(reader, source.max_sh_degree);
}
splat::Splat SpzFile::read(const std::filesystem::path& path, unsigned max_sh_degree) const {
    StreamReader reader(path);
    return read_spz_stream(reader, max_sh_degree);
}

namespace {
class SpzWriter {
public:
    SpzWriter(const splat::Splat& data, std::span<const uint32_t> indices, int version, int level)
        : data_(data), indices_(indices), version_(version), level_(level), strides_ { 9, 1, 3, 3, 4, data.sh_count() } {
        if (version != 3 && version != 4) {
            throw std::runtime_error("Unsupported SPZ output version");
        }
        if (indices.size() > std::numeric_limits<uint32_t>::max()) {
            throw std::runtime_error("Too many SPZ points");
        }
        for (size_t field = 0; field < strides_.size(); ++field) {
            offsets_[field + 1] = offsets_[field] + indices.size() * strides_[field];
        }
        append(header_, SPZ_MAGIC);
        append(header_, uint32_t(version));
        append(header_, static_cast<uint32_t>(indices.size()));
        header_.push_back(static_cast<uint8_t>(data.sh_degree));
        header_.push_back(12);
        header_.push_back(1);
        header_.push_back(version == 4 ? static_cast<uint8_t>(data.sh_degree ? 6 : 5) : 0);
    }
    void write(const codec::WriteChunk& output, const std::function<void(size_t)>& seek) const {
        if (version_ == 3) {
            const auto size = header_.size() + offsets_.back();
            const auto read = [&](size_t offset, std::span<uint8_t> bytes) {
                if (offset < header_.size()) {
                    const size_t count = std::min(bytes.size(), header_.size() - offset);
                    std::copy_n(header_.data() + offset, count, bytes.data());
                    offset += count;
                    bytes = bytes.subspan(count);
                }
                if (!bytes.empty()) {
                    encode(offset - header_.size(), bytes, false);
                }
            };
            if (level_ != -1) {
                codec::gzip_stream(size, read, output, level_);
            } else {
                Bytes bytes(std::min(size, size_t(8 * 1024 * 1024)));
                for (size_t offset = 0; offset < size;) {
                    const size_t count = std::min(bytes.size(), size - offset);
                    read(offset, std::span(bytes).first(count));
                    output(std::span(bytes).first(count));
                    offset += count;
                }
            }
            return;
        }
        const size_t streams = data_.sh_degree ? 6 : 5;
        auto header = header_;
        append(header, uint32_t(32));
        header.resize(32 + streams * 16, 0);
        output(header);
        size_t position = header.size();
        Bytes toc;
        for (size_t field = 0; field < streams; ++field) {
            const auto size = offsets_[field + 1] - offsets_[field];
            const size_t start = position;
            const auto read = [&](size_t offset, std::span<uint8_t> bytes) { encode(offsets_[field] + offset, bytes, true); };
            const auto write = [&](std::span<const uint8_t> bytes) {
                output(bytes);
                position += bytes.size();
            };
            codec::zstd_stream(size, read, write, level_);
            append(toc, uint64_t(position - start));
            append(toc, uint64_t(size));
        }
        // Each frame is already on disk; only the small directory needs a patch.
        seek(32);
        output(toc);
        seek(position);
    }

private:
    void encode_rows(size_t field, size_t first, size_t count, uint8_t* output) const {
        for (size_t row = 0; row < count; ++row, output += strides_[field]) {
            const auto& point = data_.gaussians[indices_[first + row]];
            if (field == 0) {
                for (size_t c = 0; c < 3; ++c) {
                    const auto value = static_cast<uint32_t>(static_cast<int32_t>(std::clamp(float(point.attribute(c)) * 4096, -8388607.0f, 8388607.0f)));
                    output[c * 3] = value & 255;
                    output[c * 3 + 1] = (value >> 8) & 255;
                    output[c * 3 + 2] = (value >> 16) & 255;
                }
            } else if (field == 1) {
                output[0] = codec::quantize_byte(point.attribute(splat::Alpha) * 255);
            } else if (field == 2) {
                for (size_t c = 0; c < 3; ++c) {
                    output[c] = codec::quantize_byte(((point.attribute(splat::Red + c) - 0.5f) / COLOR_SCALE + 0.5f) * 255);
                }
            } else if (field == 3) {
                for (size_t c = 0; c < 3; ++c) {
                    output[c] = codec::quantize_byte((std::log(point.attribute(splat::ScaleX + c)) + 10) * 16);
                }
            } else if (field == 4) {
                const auto& rotation = point.rotation.coeffs();
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
                for (size_t c = 0; c < 4; ++c) {
                    output[c] = static_cast<uint8_t>(packed >> (8 * c));
                }
            } else {
                for (size_t c = 0; c < data_.sh_count(); ++c) {
                    const float step = c < 9 ? 8 : 16;
                    const float quantized = std::floor((std::floor(float(point.attribute(splat::ShOffset + c)) * 128 + 0.5f) + 128 + step / 2) / step) * step;
                    output[c] = static_cast<uint8_t>(std::clamp(quantized, 0.0f, 255.0f));
                }
            }
        }
    }
    void encode_field(size_t field, size_t offset, std::span<uint8_t> bytes, bool parallel) const {
        const size_t stride = strides_[field];
        size_t first = offset / stride;
        const size_t skip = offset % stride;
        std::array<uint8_t, 45> partial;
        if (skip) {
            encode_rows(field, first++, 1, partial.data());
            const size_t count = std::min(bytes.size(), stride - skip);
            std::copy_n(partial.data() + skip, count, bytes.data());
            bytes = bytes.subspan(count);
        }
        const size_t rows = bytes.size() / stride;
        if (rows) {
            const auto run = [&](size_t begin, size_t end) { encode_rows(field, first + begin, end - begin, bytes.data() + begin * stride); };
            if (parallel) {
                parallel_rows(rows, run);
            } else {
                run(0, rows);
            }
            first += rows;
            bytes = bytes.subspan(rows * stride);
        }
        if (!bytes.empty()) {
            encode_rows(field, first, 1, partial.data());
            std::copy_n(partial.data(), bytes.size(), bytes.data());
        }
    }
    void encode(size_t offset, std::span<uint8_t> bytes, bool parallel) const {
        while (!bytes.empty()) {
            const size_t field = std::upper_bound(offsets_.begin(), offsets_.end(), offset) - offsets_.begin() - 1;
            const size_t count = std::min(bytes.size(), offsets_[field + 1] - offset);
            encode_field(field, offset - offsets_[field], bytes.first(count), parallel);
            offset += count;
            bytes = bytes.subspan(count);
        }
    }
    const splat::Splat& data_;
    std::span<const uint32_t> indices_;
    int version_, level_;
    std::array<size_t, 6> strides_;
    std::array<size_t, 7> offsets_ {};
    Bytes header_;
};
} // namespace
Bytes SpzFile::write(const splat::Splat& data, std::span<const uint32_t> indices) const {
    SpzWriter writer(data, indices, version_, compression_level_);
    Bytes output;
    size_t position = 0;
    writer.write(
        [&](std::span<const uint8_t> bytes) {
            output.resize(std::max(output.size(), position + bytes.size()));
            std::copy(bytes.begin(), bytes.end(), output.begin() + position);
            position += bytes.size();
        },
        [&](size_t offset) { position = offset; });
    return output;
}
void SpzFile::write(const std::filesystem::path& path, const splat::Splat& data, std::span<const uint32_t> indices) const {
    SpzWriter writer(data, indices, version_, compression_level_);
    FileStream output(path, FileStream::Access::Write);
    writer.write([&](std::span<const uint8_t> bytes) { output.write(bytes); }, [&](size_t offset) { output.seek(offset); });
    output.close();
}
} // namespace splat_transform::io
