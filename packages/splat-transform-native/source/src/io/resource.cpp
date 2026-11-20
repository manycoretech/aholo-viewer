#include "zip_archive.h"
#include <cstdint>
#include <curl/curl.h>
#include <io/resource.h>
#include <unordered_map>
#include <utility>
#include <utility/string.h>

namespace splat_transform::io {
bool is_archive_metadata(const std::string& entry, std::string_view format) {
    const auto slash = entry.rfind('/');
    const auto filename = utility::lower(entry.substr(slash == std::string::npos ? 0 : slash + 1));
    if (format == ".sog") {
        return filename == "meta.json";
    }
    return !filename.starts_with("._") && filename.size() > format.size() && filename.ends_with(format);
}
struct Resources::Impl {
    std::filesystem::path directory;
    std::unique_ptr<ZipArchive> archive;
    std::unordered_map<std::u8string, std::string> entries;
};
Resources::Resources(const std::filesystem::path& path, std::span<const std::byte> bytes, const std::string& format) : impl_(std::make_unique<Impl>()) {
    if (bytes.size() >= 4 && bytes[0] == std::byte { 'P' } && bytes[1] == std::byte { 'K' }) {
        impl_->archive = std::make_unique<ZipArchive>(bytes);
        std::vector<std::string> candidates;
        for (auto& name : impl_->archive->entries()) {
            const auto entry = utf8_path(name).lexically_normal();
            if (is_archive_metadata(name, format)) {
                impl_->directory = entry.parent_path();
                candidates.push_back(name);
            }
            impl_->entries.try_emplace(utility::lower(entry.generic_u8string()), std::move(name));
        }
        if (candidates.size() != 1) {
            throw std::runtime_error("Archive must contain exactly one " + format + " metadata file");
        }
        const auto metadata = impl_->archive->read(candidates[0]);
        meta = Json::parse(std::string_view(reinterpret_cast<const char*>(metadata.data()), metadata.size()));
    } else {
        impl_->directory = path.has_parent_path() ? path.parent_path() : std::filesystem::path(".");
        meta = Json::parse(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
    }
}
Resources::~Resources() = default;
std::string Resources::resolve(const std::string& name) const {
    if (name.starts_with("https://") || name.starts_with("http://")) {
        return name;
    }
    const auto relative = utf8_path(name).lexically_normal();
    const auto path = impl_->directory / relative;
    const auto by_filename = impl_->directory / relative.filename();
    if (impl_->archive) {
        for (const auto& candidate : { path, relative, by_filename }) {
            const auto entry = impl_->entries.find(utility::lower(candidate.lexically_normal().generic_u8string()));
            if (entry != impl_->entries.end()) {
                return entry->second;
            }
        }
    } else {
        for (const auto& candidate : { path, by_filename }) {
            if (std::filesystem::is_regular_file(candidate)) {
                return path_utf8(candidate);
            }
        }
        if (std::filesystem::is_directory(impl_->directory)) {
            const auto folded_name = utility::lower(std::u8string(name.begin(), name.end()));
            for (const auto& entry : std::filesystem::directory_iterator(impl_->directory)) {
                if (entry.is_regular_file() && utility::lower(entry.path().filename().u8string()) == folded_name) {
                    return path_utf8(entry.path());
                }
            }
        }
    }
    throw std::runtime_error("Missing resource: " + relative.string());
}
Bytes Resources::read(const std::string& name) const {
    const auto path = resolve(name);
    if (path.starts_with("https://") || path.starts_with("http://")) {
        static const int32_t initialized = [] {
            if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
                throw std::runtime_error("Cannot initialize HTTP client");
            }
            return 0;
        }();
        static_cast<void>(initialized);
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
                const auto bytes = std::as_bytes(std::span(data, size * count));
                output.insert(output.end(), bytes.begin(), bytes.end());
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
