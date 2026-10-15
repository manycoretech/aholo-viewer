#include "zip_archive.h"
#include <algorithm>
#include <curl/curl.h>
#include <io/resource.h>

namespace splat_transform::io {
std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return std::tolower(c); });
    return value;
}
std::string normalized(std::string value) {
    std::replace(value.begin(), value.end(), '\\', '/');
    return path_utf8(utf8_path(value).lexically_normal());
}
struct Resources::Impl {
    std::filesystem::path directory;
    std::filesystem::path metadata;
    std::unique_ptr<ZipArchive> archive;
    std::vector<std::string> entries;
};
Resources::Resources(const std::filesystem::path& path, std::span<const uint8_t> bytes, const std::string& format) : impl_(std::make_unique<Impl>()) {
    impl_->directory = path.has_parent_path() ? path.parent_path() : std::filesystem::path(".");
    if (bytes.size() >= 4 && bytes[0] == 'P' && bytes[1] == 'K') {
        impl_->archive = std::make_unique<ZipArchive>(bytes);
        impl_->entries = impl_->archive->entries();
        std::vector<std::string> candidates;
        for (const auto& name : impl_->entries) {
            const auto path = utf8_path(normalized(name));
            if (path_utf8(path.filename()).starts_with("._")) {
                continue;
            }
            if ((format == ".sog" && lower(path_utf8(path.filename())) == "meta.json") ||
                (format != ".sog" && lower(path_utf8(path.extension())) == format)) {
                candidates.push_back(name);
            }
        }
        if (candidates.size() != 1) {
            throw std::runtime_error("Archive must contain exactly one " + format + " metadata file");
        }
        impl_->metadata = utf8_path(normalized(candidates[0]));
        const auto metadata = impl_->archive->read(candidates[0]);
        meta = Json::parse(metadata.begin(), metadata.end());
    } else {
        meta = Json::parse(bytes.begin(), bytes.end());
    }
}
Resources::~Resources() = default;
std::string Resources::resolve(const std::string& name) const {
    if (name.starts_with("https://") || name.starts_with("http://")) {
        return name;
    }
    const auto relative = utf8_path(normalized(name));
    const std::array<std::filesystem::path, 3> candidates {
        impl_->metadata.parent_path() / relative, relative,
        impl_->metadata.parent_path() / relative.filename()
    };
    if (impl_->archive) {
        for (const auto& candidate : candidates) {
            const auto key = lower(normalized(path_utf8(candidate)));
            for (const auto& entry : impl_->entries) {
                if (lower(normalized(entry)) == key) {
                    return entry;
                }
            }
        }
    } else {
        for (const auto& candidate : candidates) {
            auto path = impl_->directory / candidate;
            if (std::filesystem::is_regular_file(path)) {
                return path_utf8(path);
            }
        }
        if (std::filesystem::is_directory(impl_->directory)) {
            for (const auto& entry : std::filesystem::directory_iterator(impl_->directory)) {
                if (entry.is_regular_file() && lower(path_utf8(entry.path().filename())) == lower(name)) {
                    return path_utf8(entry.path());
                }
            }
        }
    }
    throw std::runtime_error("Missing resource: " + name);
}
Bytes Resources::read(const std::string& name) const {
    const auto path = resolve(name);
    if (path.starts_with("https://") || path.starts_with("http://")) {
        static const int initialized = [] {
            if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
                throw std::runtime_error("Cannot initialize HTTP client");
            }
            return 0;
        }();
        (void)initialized;
        auto handle = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>(curl_easy_init(), curl_easy_cleanup);
        if (!handle) {
            throw std::bad_alloc();
        }
        Bytes result;
        curl_easy_setopt(handle.get(), CURLOPT_URL, path.c_str());
        curl_easy_setopt(handle.get(), CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(handle.get(), CURLOPT_FAILONERROR, 1L);
        curl_easy_setopt(handle.get(), CURLOPT_PROTOCOLS_STR, "http,https");
        curl_easy_setopt(handle.get(), CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
        curl_easy_setopt(handle.get(), CURLOPT_WRITEDATA, &result);
        curl_easy_setopt(handle.get(), CURLOPT_WRITEFUNCTION, +[](char* data, size_t size, size_t count, void* user) -> size_t {
            auto& output = *static_cast<Bytes*>(user);
            try {
                output.insert(output.end(), reinterpret_cast<uint8_t*>(data), reinterpret_cast<uint8_t*>(data) + size * count);
                return size * count;
            } catch (...) { return 0; } });
        const auto status = curl_easy_perform(handle.get());
        if (status != CURLE_OK) {
            throw std::runtime_error(curl_easy_strerror(status));
        }
        return result;
    }
    if (impl_->archive) {
        return impl_->archive->read(path);
    }
    return read_bytes(utf8_path(path));
}
} // namespace splat_transform::io
