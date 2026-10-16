#include "io/zip_archive.h"
#include <cmath>
#include <codec/codec.h>
#include <codec/quantization.h>
#include <iostream>
#include <limits>
#include <spatial/clustering.h>
#include <splat/splat.h>

namespace {
using namespace splat_transform;

template<typename Transform>
concept AcceptsQuantization = requires(const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>& matrix, std::span<const splat::AttributeView> fields, Transform&& transform) {
    { spatial::quantize_1d(matrix, std::forward<Transform>(transform)) } -> std::same_as<spatial::Quantization>;
    { spatial::quantize_1d(fields, std::forward<Transform>(transform)) } -> std::same_as<spatial::Quantization>;
};
static_assert(AcceptsQuantization<std::identity>);
static_assert(!AcceptsQuantization<int>);
static_assert(!AcceptsQuantization<decltype([](const std::string&) { return 1.0; })>);
static_assert(!AcceptsQuantization<decltype([](double) {})>);
static_assert(!AcceptsQuantization<decltype([](double) { return std::string(); })>);

void half_values() {
    for (uint32_t bits = 0; bits <= UINT16_MAX; ++bits) {
        const auto value = io::from_half(static_cast<uint16_t>(bits));
        const int exponent = (bits >> 10) & 31;
        const auto fraction = bits & 1023;
        const bool negative = (bits & 0x8000) != 0;
        if (exponent == 31 && fraction) {
            if (!std::isnan(value) || std::signbit(value) != negative) {
                throw std::runtime_error("Half NaN sign or classification changed");
            }
            continue;
        }
        const float magnitude = exponent == 31  ? std::numeric_limits<float>::infinity()
                                : exponent == 0 ? std::ldexp(float(fraction), -24)
                                                : std::ldexp(float(1024 + fraction), exponent - 25);
        const float expected = std::copysign(magnitude, negative ? -1.0f : 1.0f);
        if (std::bit_cast<uint32_t>(value) != std::bit_cast<uint32_t>(expected)) {
            throw std::runtime_error("Half decode differs from its exact binary value");
        }
    }
}

void quantization() {
    Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> matrix(12, 3);
    for (Eigen::Index row = 0; row < matrix.rows(); ++row) {
        for (Eigen::Index column = 0; column < matrix.cols(); ++column) {
            matrix(row, column) = float((row * 5 + column) % 9) * 0.25f;
        }
    }
    const auto result = spatial::quantize_1d(matrix);
    for (Eigen::Index row = 0; row < matrix.rows(); ++row) {
        for (Eigen::Index column = 0; column < matrix.cols(); ++column) {
            size_t expected = 0;
            // Linear boundary traversal is independent of the binary-search implementation.
            for (; expected < 255; ++expected) {
                if (matrix(row, column) < std::midpoint(result.centroids[expected], result.centroids[expected + 1])) {
                    break;
                }
            }
            if (result.labels(row, column) != expected) {
                throw std::runtime_error("Quantization changed boundary ties or field order");
            }
        }
    }
    size_t calls = 0;
    auto transform = [offset = std::make_unique<double>(0.125), &calls](double value) {
        ++calls;
        return value * 2.5 - *offset;
    };
    static_assert(AcceptsQuantization<decltype(transform)&>);
    static_assert(AcceptsQuantization<decltype(transform)>);
    auto transformed = matrix;
    for (Eigen::Index i = 0; i < transformed.size(); ++i) {
        transformed.data()[i] = static_cast<float>(double(transformed.data()[i]) * 2.5 - 0.125);
    }
    const auto expected = spatial::quantize_1d(transformed);
    const auto actual = spatial::quantize_1d(matrix, transform);
    if (calls != static_cast<size_t>(matrix.size()) || actual.centroids != expected.centroids || actual.labels != expected.labels) {
        throw std::runtime_error("Template quantization lost a captured or move-only transform");
    }
    splat::Splat data(static_cast<size_t>(matrix.rows()), 0);
    for (size_t i = 0; i < data.size(); ++i) {
        for (size_t c = 0; c < 3; ++c) {
            data.gaussians[i].scale[c] = matrix(i, c);
        }
    }
    const std::array fields { splat::AttributeView(data, splat::ScaleX), splat::AttributeView(data, splat::ScaleY), splat::AttributeView(data, splat::ScaleZ) };
    const auto attributes = spatial::quantize_1d(fields, std::move(transform));
    if (attributes.centroids != expected.centroids || attributes.labels != expected.labels) {
        throw std::runtime_error("Attribute and matrix quantization disagree");
    }
    const auto constant = spatial::quantize_1d(Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>::Constant(4, 2, 1));
    if (!constant.labels.isZero() || !std::ranges::all_of(constant.centroids, [](float value) { return value == 1; })) {
        throw std::runtime_error("Constant quantization changed its zero-bin convention");
    }
    if (spatial::quantize_1d(Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>(0, 3)).labels.size() != 0) {
        throw std::runtime_error("Empty quantization produced labels");
    }
    Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> shifted(512, 1);
    for (Eigen::Index row = 0; row < shifted.rows(); ++row) {
        shifted(row, 0) = 10000.0f + float(row % 65) * 0.001f;
    }
    const auto shifted_result = spatial::quantize_1d(shifted);
    for (Eigen::Index row = 0; row < shifted.rows(); ++row) {
        if (std::abs(shifted_result.centroids[shifted_result.labels(row, 0)] - shifted(row, 0)) > 0.002f) {
            throw std::runtime_error("Float quantization lost local differences at a large offset");
        }
    }
}
void codec_numeric() {
    for (float value : { -1000.0f, -1e-8f, 0.0f, 1e-8f, 1000.0f }) {
        const auto result = codec::signed_exp(codec::signed_log(value));
        if (std::abs(result - value) > std::abs(value) * 2e-6f) {
            throw std::runtime_error("Signed log/exp lost float precision");
        }
    }
    for (size_t count : { size_t { 0 }, size_t { 1 }, size_t { 17 }, size_t { 0x1000001 }, size_t { UINT32_MAX } }) {
        const auto [width, height] = codec::texture_size(count);
        if (width % 4 || height % 4 || uint64_t(width) * height < count) {
            throw std::runtime_error("Texture dimensions do not cover the integer point count");
        }
    }
}
} // namespace

int main() {
    try {
        using namespace splat_transform;
        const io::Bytes input { 0, 1, 2, 255, 0, 3, 17, 42 };
        if (codec::gunzip(codec::gzip(input)) != input || codec::zstd_decompress(codec::zstd_compress(input)) != input) {
            throw std::runtime_error("Compression roundtrip failed");
        }
        io::Bytes large(9 * 1024 * 1024 + 117);
        uint32_t random = 12345;
        for (size_t i = 0; i < large.size(); ++i) {
            random = random * 1664525 + 1013904223;
            large[i] = i % 8 < 3 ? uint8_t(random >> 24) : uint8_t(i / 1024);
        }
        for (const bool gzip : { true, false }) {
            const auto encoded = gzip ? codec::gzip(large, 6) : codec::zstd_compress(large, 7);
            if ((gzip ? codec::gunzip(encoded) : codec::zstd_decompress(encoded)) != large) {
                throw std::runtime_error("Parallel compression corrupted block boundaries or checksums");
            }
        }
        const auto archive_bytes = io::zip({ { "a/data.bin", input } });
        if (io::ZipArchive(archive_bytes).read("a/data.bin") != input) {
            throw std::runtime_error("Archive roundtrip failed");
        }
        for (float value : { 0.0f, 1.0f, -1.0f, 0.5f, 65504.0f }) {
            if (io::from_half(io::to_half(value)) != value) {
                throw std::runtime_error("Half conversion failed");
            }
        }
        half_values();
        quantization();
        codec_numeric();
        bool truncated = false;
        try {
            io::ByteReader reader(input);
            reader.take(9);
        } catch (const std::runtime_error&) {
            truncated = true;
        }
        if (!truncated) {
            throw std::runtime_error("Truncated input was accepted");
        }
        splat::Splat points(3, 0);
        points.gaussians[0].mean.x() = 2;
        points.gaussians[1].mean.x() = 0;
        points.gaussians[2].mean.x() = 1;
        if (splat::morton_order(points) != std::vector<uint32_t> { 1, 2, 0 }) {
            throw std::runtime_error("Morton order failed");
        }
        std::cout << "Core tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
