#include <cmath>
#include <io/lcc2.h>
#include <io/resource.h>
#include <numeric>

namespace splat_transform::io {
splat::Splat Lcc2File::read(const FileInput& source) const {
    const auto bytes = source.bytes;
    const auto& path = source.path;
    Resources resources(path, bytes, ".lcc2");
    const auto& meta = resources.meta;
    auto version = meta.value("version", "0.0.1");
    if (version != "0.0.1" && version != "0.0.2" && version != "0.0.3") {
        throw std::runtime_error("Unsupported LCC2 version");
    }
    const int levels = meta.value("totalLevels", meta.value("lod_level", 0));
    if (levels < 1) {
        throw std::runtime_error("Invalid LCC2 level count");
    }
    auto extension = lower(meta.value("splatType", ".sog"));
    if (!extension.starts_with('.')) {
        extension.insert(extension.begin(), '.');
    }
    if (extension == ".lcc" || extension == ".lcc2") {
        throw std::runtime_error("Nested LCC resources are unsupported");
    }
    const auto& root = meta.at("root");
    const auto& files = root.contains("splatFiles") ? root.at("splatFiles") : root.at("files");
    std::vector<std::pair<std::string, std::vector<Json>>> selected;
    auto add = [&](const Json& ref) {
        auto name = files.at(ref.at("name").get<size_t>()).get<std::string>();
        if (!root.contains("splatFiles") && !lower(name).ends_with(extension)) {
            name += extension;
        }
        const auto resolved = resources.resolve(name);
        auto found = std::find_if(selected.begin(), selected.end(), [&](const auto& value) { return resources.resolve(value.first) == resolved; });
        if (found == selected.end()) {
            selected.emplace_back(name, std::vector<Json> { ref });
        } else {
            found->second.push_back(ref);
        }
    };
    const auto env = root.value("data", Json::object()).value("env", Json());
    const auto visit = [&](auto&& self, const Json& node, int depth) -> void {
        const auto ref = node.value("data", Json::object()).value("3dgs", Json());
        if (depth == levels && ref.is_object() && (!env.is_object() || ref.at("name") != env.at("name"))) {
            add(ref);
        }
        if (depth < levels && node.contains("child")) {
            for (const auto& child : node.at("child")) {
                self(self, child, depth + 1);
            }
        }
    };
    visit(visit, root, 0);
    if (selected.empty()) {
        throw std::runtime_error("No LCC2 LOD0 resources");
    }
    if (env.is_object()) {
        add(env);
    }
    std::vector<splat::Splat> parts;
    for (const auto& [name, refs] : selected) {
        const auto input = resources.read(name);
        auto format = create_file(extension);
        auto part = format->read({ utf8_path(resources.resolve(name)), input, source.max_sh_degree });
        std::vector<std::pair<size_t, size_t>> ranges;
        for (const auto& ref : refs) {
            const auto start = ref.value("start", int64_t(0));
            const auto count = ref.value("count", int64_t(part.size()) - start);
            if (start < 0 || count < 0 || uint64_t(start) + uint64_t(count) > part.size()) {
                throw std::runtime_error("Invalid LCC2 splat range");
            }
            ranges.emplace_back(static_cast<size_t>(start), static_cast<size_t>(start + count));
        }
        std::ranges::sort(ranges);
        std::vector<uint32_t> indices;
        size_t previous_end = 0;
        for (auto [start, end] : ranges) {
            start = std::max(start, previous_end);
            for (size_t i = start; i < end; ++i) {
                indices.push_back(static_cast<uint32_t>(i));
            }
            previous_end = std::max(previous_end, end);
        }
        parts.push_back(std::move(part).select(indices));
    }
    return splat::combine(std::move(parts));
}
} // namespace splat_transform::io
