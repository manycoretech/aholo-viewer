#include <io/file.h>
#include <io/json.h>

namespace splat_transform::io {
Json read_json(const std::filesystem::path& path) {
    const auto bytes = read_bytes(path);
    return Json::parse(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}
} // namespace splat_transform::io
