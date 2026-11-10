#include <io/file.h>
#include <io/json.h>

namespace splat_transform::io {
Json read_json(const std::filesystem::path& path) {
    const auto bytes = read_bytes(path);
    return Json::parse(bytes.begin(), bytes.end());
}
} // namespace splat_transform::io
