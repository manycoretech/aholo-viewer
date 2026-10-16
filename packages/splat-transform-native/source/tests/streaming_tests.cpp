#include "codec/compression_stream.h"
#include "io/file_stream.h"
#include "io/stream_reader.h"
#include <chrono>
#include <codec/codec.h>
#include <io/esz.h>
#include <io/ply.h>
#include <io/splat.h>
#include <io/spz.h>
#include <iostream>
#include <numeric>

using namespace splat_transform;
namespace {
void require(bool value, const char* message) {
    if (!value) {
        throw std::runtime_error(message);
    }
}
template<typename F>
void rejects(F&& operation) {
    bool rejected = false;
    try {
        operation();
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, "Truncated stream was accepted");
}
void same(const splat::Splat& left, const splat::Splat& right) {
    require(left.size() == right.size() && left.sh_degree == right.sh_degree, "Stream changed splat shape");
    for (size_t i = 0; i < left.size(); ++i) {
        for (size_t c = 0; c < left.attribute_count(); ++c) {
            require(std::bit_cast<uint32_t>(left.gaussians[i].attribute(c)) == std::bit_cast<uint32_t>(right.gaussians[i].attribute(c)), "File and memory decoders differ");
        }
    }
}
void file_backends(const std::filesystem::path& directory, bool require_native) {
    io::Bytes expected(1024 * 1024 + 37);
    for (size_t i = 0; i < expected.size(); ++i) {
        expected[i] = static_cast<uint8_t>(i * 97 + i / 251);
    }
    for (auto backend : { io::FileStream::Backend::Automatic, io::FileStream::Backend::ThreadPool }) {
        const auto path = directory / io::utf8_path("流式输入输出.bin");
        {
            io::FileStream file(path, io::FileStream::Access::Write, backend);
            const bool native = file.uses_native_backend();
            if (backend == io::FileStream::Backend::Automatic) {
                std::cout << "Automatic file writer backend: " << (native ? "Asio native" : "thread pool fallback") << '\n';
                require(!require_native || native, "Automatic file writer entered fallback");
            } else {
                require(!native, "Forced file writer fallback was ignored");
            }
            file.write(std::span(expected).first(13));
            file.write(std::span(expected).subspan(13));
            expected[7] ^= 0x5a;
            file.seek(7);
            file.write(std::span(expected).subspan(7, 1));
            require(file.size() == expected.size(), "Backpatch truncated output length");
            file.close();
        }
        io::FileStream file(path, io::FileStream::Access::Read, backend);
        const bool native = file.uses_native_backend();
        if (backend == io::FileStream::Backend::Automatic) {
            std::cout << "Automatic file reader backend: " << (native ? "Asio native" : "thread pool fallback") << '\n';
            require(!require_native || native, "Automatic file reader entered fallback");
        } else {
            require(!native, "Forced file reader fallback was ignored");
        }
        require(file.size() == expected.size(), "Asio file size changed");
        io::Bytes actual(expected.size() + 17);
        require(file.read(std::span(actual).first(3)) == 3, "Short file read changed");
        require(file.read(std::span(actual).subspan(3)) == expected.size() - 3, "Final partial file read changed");
        require(file.read(actual) == 0, "File EOF changed");
        require(std::equal(expected.begin(), expected.end(), actual.begin()), "Asio file bytes changed");
        file.close();
    }
}
void compressed_windows() {
    io::Bytes expected(4 * 1024 * 1024 + 131);
    for (size_t i = 0; i < expected.size(); ++i) {
        expected[i] = static_cast<uint8_t>((i / 31) % 251);
    }
    for (bool gzip : { false, true }) {
        const auto encoded = gzip ? codec::gzip(expected, 1) : codec::zstd_compress(expected, 1);
        const auto check = [&](std::span<const uint8_t> bytes, bool bounded) {
            io::StreamReader source(bytes, 17);
            auto decoded = gzip ? io::gzip_reader(source) : io::zstd_reader(source, bounded ? encoded.size() : std::numeric_limits<size_t>::max());
            for (size_t offset = 0; offset < expected.size();) {
                const size_t count = std::min(size_t(131071), expected.size() - offset);
                const auto part = decoded.take(count);
                require(std::equal(part.begin(), part.end(), expected.begin() + offset), "Stream decompression changed bytes");
                offset += count;
            }
            decoded.require_end();
            if (bounded) {
                require(source.read<uint8_t>() == 0x42, "Zstd stream consumed the following attribute");
            }
        };
        check(encoded, false);
        rejects([&] { check(std::span(encoded).first(encoded.size() - 1), false); });
        if (!gzip) {
            auto followed = encoded;
            followed.push_back(0x42);
            check(followed, true);
        }
    }
    // A highly compressible final frame can exhaust its compressed input while
    // still holding output internally. The reader must drain before testing EOF.
    const auto compressed = codec::zstd_compress(io::Bytes(5 * 1024 * 1024, 0), 1);
    io::StreamReader source(compressed, 7);
    auto decoded = io::zstd_reader(source);
    decoded.skip(5 * 1024 * 1024);
    decoded.require_end();
}
void compressed_writes() {
    io::Bytes expected(17 * 1024 * 1024 + 113);
    uint32_t random = 37;
    for (size_t i = 0; i < expected.size(); ++i) {
        random = random * 1664525 + 1013904223;
        expected[i] = i % 8 < 3 ? uint8_t(random >> 24) : uint8_t(i / 1024);
    }
    for (size_t size : { size_t(0), size_t(131075), size_t(2 * 1024 * 1024 - 1), expected.size() }) {
        for (int level : { 1, 6 }) {
            for (bool gzip : { false, true }) {
                const auto input = std::span(expected).first(size);
                io::Bytes output;
                const auto read = [&](size_t offset, std::span<uint8_t> target) {
                    require(offset <= size && target.size() <= size - offset, "Compression read outside input");
                    std::copy_n(input.begin() + offset, target.size(), target.begin());
                };
                const auto write = [&](std::span<const uint8_t> bytes) { output.insert(output.end(), bytes.begin(), bytes.end()); };
                if (gzip) {
                    codec::gzip_stream(size, read, write, level);
                    require(output == codec::gzip(input, level), "Streamed gzip changed DEFLATE blocks or CRC");
                    require(codec::gunzip(output) == io::Bytes(input.begin(), input.end()), "Streamed gzip payload differs");
                } else {
                    codec::zstd_stream(size, read, write, level);
                    require(codec::zstd_decompress(output) == io::Bytes(input.begin(), input.end()), "Streamed Zstd payload differs");
                }
            }
        }
    }
}
void spz_shapes(const std::filesystem::path& directory) {
    for (unsigned degree = 0; degree <= 3; ++degree) {
        splat::Splat source(97, degree);
        for (size_t i = 0; i < source.size(); ++i) {
            auto& p = source.gaussians[i];
            p.mean = Eigen::Vector3f(float(i) / 13, -float(i) / 17, float(i) / 19);
            p.scale = Eigen::Vector3f(0.3f, 0.7f, 1.1f);
            p.rotation = Eigen::Quaternionf(0.2f, -0.8f, 0.4f, -0.1f).normalized();
            p.opacity = float(i) / 96;
            for (size_t c = 0; c < p.sh.size(); ++c) {
                p.sh[c] = float(int((i + c) % 23) - 11) / 16;
            }
        }
        for (size_t count : { size_t(0), size_t(1), source.size() }) {
            std::vector<uint32_t> indices(count);
            for (size_t i = 0; i < count; ++i) {
                indices[i] = uint32_t((source.size() - 1 - i) / 2);
            }
            const auto raw = io::SpzFile(3, -1).write(source, indices);
            const auto expected = io::SpzFile().read({ "expected.uspz", raw, degree });
            for (int version : { 3, 4 }) {
                const io::SpzFile format(version, 6);
                const auto path = directory / "shape.spz";
                format.write(path, source, indices);
                require(io::read_bytes(path) == format.write(source, indices), "File and memory SPZ writers differ");
                same(expected, io::read_splat(path));
            }
        }
    }
}
void format_streams(const std::filesystem::path& directory) {
    splat::Splat source(300001, 3);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& p = source.gaussians[i];
        p.mean = Eigen::Vector3f(float(i % 97) / 8, float(i % 113) / 8, float(i % 127) / 8);
        p.scale = Eigen::Vector3f(0.5f, 0.25f, 1.0f);
        p.rotation = Eigen::Quaternionf::Identity();
        p.opacity = float(i % 255) / 255;
        for (size_t c = 0; c < p.sh.size(); ++c) {
            p.sh[c] = float(int((i * 7 + c * 3) % 97) - 48) / 128;
        }
    }
    std::vector<uint32_t> indices(source.size());
    std::iota(indices.begin(), indices.end(), 0);
    const auto check = [&](const io::IFile& format, const char* name) {
        const auto bytes = format.write(source, indices);
        const auto path = directory / name;
        format.write(path, source, indices);
        require(io::read_bytes(path) == bytes, "File and memory writers differ");
        for (unsigned retained : { 0u, 3u }) {
            const auto memory = format.read({ path, bytes, retained });
            const auto file = io::read_splat(path, retained);
            same(memory, file);
            require(file.block_offsets == std::vector<size_t> { 0 } && file.block_counts == std::vector<size_t> { source.size() }, "Streaming path lost block metadata");
        }
        if (std::string(name) != "scene.splat") {
            io::write_bytes(path, std::span(bytes).first(bytes.size() - 1));
            rejects([&] { io::read_splat(path); });
        }
    };
    check(io::PlyFile(), "scene.PLY");
    check(io::SplatFile(), "scene.splat");
    check(io::SpzFile(3, 1), "v3.spz");
    check(io::SpzFile(4, 1), "v4.spz");
    check(io::EszFile(true), "high.esz");
    check(io::EszFile(false), "low.esz");
}
} // namespace
int main(int argc, char** argv) {
    const auto directory = std::filesystem::temp_directory_path() / ("splat-streaming-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup { directory };
    try {
        const bool require_native = argc == 2 && std::string_view(argv[1]) == "--require-native-file-io";
        require(argc == 1 || require_native, "Unknown streaming test argument");
        file_backends(directory, require_native);
        compressed_windows();
        compressed_writes();
        spz_shapes(directory);
        format_streams(directory);
        std::cout << "Asio file backends, bounded compression, and streaming format parity passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
