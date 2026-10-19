#pragma once
#include <io/resource.h>
#include <limits>
#include <memory>
#include <zip.h>

namespace splat_transform::io {
// The input span remains alive for the duration of this archive reader.
class ZipArchive {
public:
    explicit ZipArchive(std::span<const uint8_t> bytes) {
        zip_error_t error;
        zip_error_init(&error);
        auto guard = std::unique_ptr<zip_error_t, decltype(&zip_error_fini)>(&error, zip_error_fini);
        auto* source = zip_source_buffer_create(bytes.data(), bytes.size(), 0, &error);
        if (!source) {
            throw std::runtime_error(zip_error_strerror(&error));
        }
        auto* archive = zip_open_from_source(source, ZIP_RDONLY, &error);
        if (!archive) {
            zip_source_free(source);
            throw std::runtime_error(zip_error_strerror(&error));
        }
        archive_.reset(archive);
    }
    std::vector<std::string> entries() const {
        std::vector<std::string> result;
        const auto count = zip_get_num_entries(archive_.get(), 0);
        if (count < 0) {
            throw std::runtime_error(zip_strerror(archive_.get()));
        }
        for (zip_uint64_t i = 0; i < uint64_t(count); ++i) {
            const char* name = zip_get_name(archive_.get(), i, 0);
            if (!name) {
                throw std::runtime_error(zip_strerror(archive_.get()));
            }
            const std::string value(name);
            if (!value.empty() && value.back() != '/' && value.back() != '\\') {
                result.push_back(value);
            }
        }
        return result;
    }
    Bytes read(const std::string& name) const {
        zip_stat_t stat;
        if (zip_stat(archive_.get(), name.c_str(), 0, &stat) != 0 || stat.size > std::numeric_limits<size_t>::max()) {
            throw std::runtime_error("Cannot read ZIP entry: " + normalized(name));
        }
        auto file = std::unique_ptr<zip_file_t, decltype(&zip_fclose)>(zip_fopen(archive_.get(), name.c_str(), 0), zip_fclose);
        if (!file) {
            throw std::runtime_error(zip_strerror(archive_.get()));
        }
        Bytes output(size_t(stat.size));
        size_t offset = 0;
        while (offset < output.size()) {
            const auto count = zip_fread(file.get(), output.data() + offset, output.size() - offset);
            if (count <= 0) {
                throw std::runtime_error("Truncated ZIP entry: " + normalized(name));
            }
            offset += size_t(count);
        }
        return output;
    }

private:
    std::unique_ptr<zip_t, decltype(&zip_discard)> archive_ { nullptr, zip_discard };
};
} // namespace splat_transform::io
