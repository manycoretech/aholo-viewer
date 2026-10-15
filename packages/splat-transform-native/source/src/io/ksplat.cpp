#include <cmath>
#include <io/ksplat.h>

namespace splat_transform::io {
splat::Splat KsplatFile::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const ByteReader input(bytes);
    if (input.read_at<uint8_t>(0) != 0 || input.read_at<uint8_t>(1) < 1) {
        throw std::runtime_error("Unsupported KSPLAT version");
    }
    const auto section_count = input.read_at<uint32_t>(4);
    const auto count = input.read_at<uint32_t>(16);
    const auto compression = input.read_at<uint16_t>(20);
    if (compression > 2) {
        throw std::runtime_error("Invalid KSPLAT compression");
    }
    float sh_min = input.read_at<float>(36), sh_max = input.read_at<float>(40);
    if (sh_min == 0) {
        sh_min = -1.5f;
    }
    if (sh_max == 0) {
        sh_max = 1.5f;
    }
    unsigned degree = 0;
    for (size_t s = 0; s < section_count; ++s) {
        degree = std::max(degree, unsigned(input.read_at<uint16_t>(4096 + s * 1024 + 40)));
    }
    splat::Splat result(count, source.retained_degree(degree));
    constexpr std::array<size_t, 45> SH_INDEX {
        0, 3, 6, 1, 4, 7, 2, 5, 8, 9, 14, 19, 10, 15, 20, 11, 16, 21, 12, 17, 22, 13, 18, 23,
        24, 31, 38, 25, 32, 39, 26, 33, 40, 27, 34, 41, 28, 35, 42, 29, 36, 43, 30, 37, 44
    };
    size_t section_base = 4096 + size_t(section_count) * 1024;
    size_t output = 0;
    for (size_t s = 0; s < section_count; ++s) {
        const ByteReader header(bytes.subspan(4096 + s * 1024));
        const auto n = header.read_at<uint32_t>(0), capacity = header.read_at<uint32_t>(4);
        const auto bucket_size = header.read_at<uint32_t>(8), bucket_count = header.read_at<uint32_t>(12);
        const auto block_size = header.read_at<float>(16);
        const auto bucket_storage = header.read_at<uint16_t>(20);
        auto range = header.read_at<uint32_t>(24);
        if (!range) {
            range = compression == 0 ? 1 : 32767;
        }
        const auto full_count = header.read_at<uint32_t>(32), partial_count = header.read_at<uint32_t>(36);
        const size_t sh_count = splat::SH_COUNTS.at(header.read_at<uint16_t>(40));
        const size_t scalar_bytes = compression == 0 ? 4 : 2;
        const size_t sh_bytes = compression == 0 ? 4 : compression == 1 ? 2
                                                                        : 1;
        const size_t stride = scalar_bytes * 10 + 4 + sh_count * sh_bytes;
        const size_t bucket_base = section_base + size_t(partial_count) * 4;
        const size_t data_base = bucket_base + size_t(bucket_storage) * bucket_count;
        size_t partial = full_count, partial_start = size_t(full_count) * bucket_size;
        for (size_t i = 0; i < n; ++i, ++output) {
            if (output >= count) {
                throw std::runtime_error("KSPLAT count mismatch");
            }
            size_t bucket = 0;
            if (compression) {
                if (i < size_t(full_count) * bucket_size) {
                    if (!bucket_size) {
                        throw std::runtime_error("Invalid KSPLAT bucket size");
                    }
                    bucket = i / bucket_size;
                } else {
                    while (partial < size_t(full_count) + partial_count) {
                        auto length = input.read_at<uint32_t>(section_base + (partial - full_count) * 4);
                        if (i < partial_start + length) {
                            break;
                        }
                        ++partial;
                        partial_start += length;
                    }
                    bucket = partial;
                    if (bucket >= bucket_count) {
                        throw std::runtime_error("Invalid KSPLAT bucket index");
                    }
                }
            }
            const auto record_offset = data_base + i * stride;
            if (record_offset > bytes.size() || stride > bytes.size() - record_offset) {
                throw std::runtime_error("Truncated KSPLAT record");
            }
            ByteReader reader(bytes.subspan(record_offset, stride));
            for (size_t axis = 0; axis < 3; ++axis) {
                result.gaussians[output].attribute(axis) = compression == 0 ? reader.read<float>() : static_cast<float>((float(reader.read<uint16_t>()) - range) * block_size / 2 / range + input.read_at<float>(bucket_base + (bucket * 3 + axis) * 4));
            }
            for (size_t axis = 0; axis < 3; ++axis) {
                result.gaussians[output].attribute(splat::ScaleX + axis) = compression == 0 ? reader.read<float>() : from_half(reader.read<uint16_t>());
            }
            for (size_t c = 0; c < 4; ++c) {
                result.gaussians[output].attribute(c == 0 ? splat::QuatW : splat::QuatX + c - 1) = compression == 0 ? reader.read<float>() : from_half(reader.read<uint16_t>());
            }
            for (size_t c = 0; c < 4; ++c) {
                result.gaussians[output].attribute(c == 3 ? splat::Alpha : splat::Red + c) = static_cast<float>(reader.read<uint8_t>() / 255.0f);
            }
            const ByteReader sh(reader.take(sh_count * sh_bytes));
            for (size_t c = 0; c < std::min(sh_count, result.sh_count()); ++c) {
                result.gaussians[output].attribute(splat::ShOffset + c) = compression == 0 ? sh.read_at<float>(SH_INDEX[c] * 4) : compression == 1 ? from_half(sh.read_at<uint16_t>(SH_INDEX[c] * 2))
                                                                                                                                                   : (sh_min + sh.read_at<uint8_t>(SH_INDEX[c]) / 255.0f * (sh_max - sh_min));
            }
            result.normalize_rotation(output);
        }
        section_base = data_base + stride * capacity;
    }
    if (output != count) {
        throw std::runtime_error("KSPLAT section count mismatch");
    }
    return result;
}
} // namespace splat_transform::io
