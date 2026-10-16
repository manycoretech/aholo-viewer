#include "zip_archive.h"
#include <io/esz.h>
#include <io/ksplat.h>
#include <io/lcc.h>
#include <io/lcc2.h>
#include <io/ply.h>
#include <io/resource.h>
#include <io/sog.h>
#include <io/splat.h>
#include <io/spz.h>
#include <numeric>

namespace splat_transform::io {
namespace {
struct Format {
    std::string_view extension;
    bool writable;
    std::unique_ptr<IFile> (*create)(const Json&);
};
template<typename T>
std::unique_ptr<IFile> make_file(const Json&) {
    return std::make_unique<T>();
}
const std::array FORMATS {
    Format { ".ply", true, make_file<PlyFile> },
    Format { ".spz", true, [](const Json& config) -> std::unique_ptr<IFile> {
                const auto version = config.value("version", 3);
                return std::make_unique<SpzFile>(version, config.value("compressLevel", version == 3 ? 6 : 7));
            } },
    Format { ".uspz", true, [](const Json&) -> std::unique_ptr<IFile> { return std::make_unique<SpzFile>(3, -1); } },
    Format { ".splat", true, make_file<SplatFile> },
    Format { ".sog", true, make_file<SogFile> },
    Format { ".json", false, make_file<SogFile> },
    Format { ".esz", true, [](const Json& config) -> std::unique_ptr<IFile> { return std::make_unique<EszFile>(config.value("highPrecision", false)); } },
    Format { ".ksplat", false, make_file<KsplatFile> },
    Format { ".lcc", false, make_file<LccFile> },
    Format { ".lcc2", false, make_file<Lcc2File> },
};
struct ArchiveFormat {
    std::string_view extension;
    std::string_view metadata_extension;
    std::string_view metadata_name;
};
// Highest-priority metadata wins, independently of ZIP entry order.
constexpr std::array ARCHIVE_FORMATS {
    ArchiveFormat { ".lcc2", ".lcc2", "" },
    ArchiveFormat { ".lcc", ".lcc", "" },
    ArchiveFormat { ".sog", "", "meta.json" }
};
std::string input_extension(const FileInput& input) {
    auto extension = lower(input.path.extension().string());
    if (extension != ".zip") {
        return extension;
    }
    const auto entries = ZipArchive(input.bytes).entries();
    for (const auto& format : ARCHIVE_FORMATS) {
        for (const auto& entry : entries) {
            const auto path = utf8_path(entry);
            if ((!format.metadata_extension.empty() && lower(path.extension().string()) == format.metadata_extension) ||
                (!format.metadata_name.empty() && path.filename() == format.metadata_name)) {
                return std::string(format.extension);
            }
        }
    }
    throw std::runtime_error("Unsupported ZIP splat format");
}
} // namespace

Bytes IFile::write(const splat::Splat&, std::span<const uint32_t>) const {
    throw std::runtime_error("Writing is unsupported for " + std::string(name()));
}
void IFile::write(const std::filesystem::path& path, const splat::Splat& splat, std::span<const uint32_t> indices) const {
    write_bytes(path, write(splat, indices));
}
splat::Splat IFile::read(const std::filesystem::path& path, unsigned max_sh_degree) const {
    const auto bytes = read_bytes(path);
    return read({ path, bytes, max_sh_degree });
}
std::unique_ptr<IFile> create_file(std::string_view extension, const Json& options, FileOperation operation) {
    const auto normalized = lower(std::string(extension));
    const auto found = std::ranges::find(FORMATS, normalized, &Format::extension);
    if (found == FORMATS.end() || (operation == FileOperation::Write && !found->writable)) {
        throw std::runtime_error(std::string("Unsupported ") + (operation == FileOperation::Read ? "input" : "output") + " format: " + normalized);
    }
    return found->create(options);
}
splat::Splat read_splat(const FileInput& input) {
    auto result = create_file(input_extension(input))->read(input);
    result.block_offsets = { 0 };
    result.block_counts = { result.size() };
    return result;
}
splat::Splat read_splat(const std::filesystem::path& path, unsigned max_sh_degree) {
    const auto extension = lower(path.extension().string());
    if (extension != ".zip") {
        auto result = create_file(extension)->read(path, max_sh_degree);
        result.block_offsets = { 0 };
        result.block_counts = { result.size() };
        return result;
    }
    auto bytes = read_bytes(path);
    return read_splat({ path, bytes, max_sh_degree });
}
void write_splat(const std::filesystem::path& path, const splat::Splat& splat, const Json& options) {
    auto format = create_file(path.extension().string(), options, FileOperation::Write);
    std::vector<uint32_t> indices;
    if (options.value("enableMortonSort", true)) {
        indices = splat::morton_order(splat);
    } else {
        indices.resize(splat.size());
        std::iota(indices.begin(), indices.end(), 0);
    }
    format->write(path, splat, indices);
}
} // namespace splat_transform::io
