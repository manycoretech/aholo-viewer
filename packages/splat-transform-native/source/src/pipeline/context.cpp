#include <algorithm>
#include <memory>
#include <new>
#include <pipeline/context.h>
#include <string_view>
#include <xxhash.h>

namespace splat_transform::pipeline {
namespace {
bool same_voxel_paths(const io::Json& previous, const io::Json& current) {
    if (!previous.is_array() || previous.size() != current.size()) {
        return false;
    }
    std::unordered_set<std::string_view> remaining;
    remaining.reserve(current.size());
    for (const auto& path : current) {
        remaining.insert(path.get_ref<const std::string&>());
    }
    // Erasing matched paths also rejects duplicates in existing metadata.
    return std::ranges::all_of(previous, [&](const io::Json& path) {
        return path.is_string() && remaining.erase(path.get_ref<const std::string&>()) == 1;
    });
}
} // namespace
const Resource& TaskContext::input(const io::Json& config) const {
    return resources_.at(config.at("input").get<std::string>()).data;
}
const SplatPtr& TaskContext::splat_ptr(const io::Json& config) const {
    const auto& resource = input(config);
    if (const auto* data = std::get_if<SplatPtr>(&resource)) {
        return *data;
    }
    const auto& files = std::get<std::vector<SingleFile>>(resource);
    if (files.empty() || !std::holds_alternative<SplatPtr>(files.front().content)) {
        throw std::runtime_error("Task requires splat data");
    }
    return std::get<SplatPtr>(files.front().content);
}
splat::Splat TaskContext::take_splat(const io::Json& config) {
    const auto& pointer = splat_ptr(config);
    const auto name = config.at("input").get<std::string>();
    const bool disposable = config.value("output", "") == name || releases_.contains(name);
    // Retained resources and aliases remain valid. A replaced/released sole owner
    // can transfer its Gaussian and SH allocations directly into the task.
    if (disposable && pointer.use_count() == 1) {
        return std::move(*pointer);
    }
    return *pointer;
}
void TaskContext::set(const io::Json& config, Resource resource) {
    size_t source;
    if (config.contains("input")) {
        source = resources_.at(config.at("input").get<std::string>()).source;
    } else if (config.contains("inputs")) {
        auto hash = std::unique_ptr<XXH3_state_t, decltype(&XXH3_freeState)>(XXH3_createState(), &XXH3_freeState);
        if (!hash) {
            throw std::bad_alloc();
        }
        XXH3_64bits_reset(hash.get());
        // Length prefixes preserve path boundaries, input order, and repeated inputs.
        for (const auto& input : config.at("inputs")) {
            const auto path = io::path_utf8(std::filesystem::absolute(io::utf8_path(input.get<std::string>())).lexically_normal());
            XXH64_canonical_t length;
            XXH64_canonicalFromHash(&length, path.size());
            XXH3_64bits_update(hash.get(), &length, sizeof(length));
            XXH3_64bits_update(hash.get(), path.data(), path.size());
        }
        const auto [entry, inserted] = read_sources_.try_emplace(XXH3_64bits_digest(hash.get()), next_source_);
        source = entry->second;
        if (inserted) {
            ++next_source_;
        }
    } else {
        source = next_source_++;
    }
    resources_.insert_or_assign(config.at("output").get<std::string>(), Entry { std::move(resource), source });
}
void TaskContext::begin_task(const io::Json& releases) {
    releases_.clear();
    for (const auto& name : releases) {
        releases_.insert(name.get<std::string>());
    }
}
void TaskContext::finish_task() {
    for (const auto& name : releases_) {
        resources_.erase(name);
    }
    releases_.clear();
}
void TaskContext::record_voxel(const io::Json& config) {
    const auto path = std::filesystem::absolute(io::utf8_path(config.at("output").get<std::string>()) / "voxel-meta.json").lexically_normal();
    voxel_outputs_.insert_or_assign(path, resources_.at(config.at("input").get<std::string>()).source);
    update_lod_metadata();
}
void TaskContext::record_lod_metadata(const io::Json& config, const std::filesystem::path& path) {
    lod_outputs_.insert_or_assign(std::filesystem::absolute(path).lexically_normal(), resources_.at(config.at("input").get<std::string>()).source);
    update_lod_metadata();
}
void TaskContext::update_lod_metadata() {
    // Output directories can be replaced by later Write tasks. Never keep links
    // to deleted files or update metadata belonging to a previous output.
    const auto missing = [](const auto& output) { return !std::filesystem::is_regular_file(output.first); };
    std::erase_if(voxel_outputs_, missing);
    std::erase_if(lod_outputs_, missing);
    for (const auto& [path, source] : lod_outputs_) {
        auto voxels = io::Json::array();
        for (const auto& [voxel, voxel_source] : voxel_outputs_) {
            if (voxel_source != source) {
                continue;
            }
            const auto relative = voxel.lexically_relative(path.parent_path());
            if (relative.empty()) {
                throw std::runtime_error("Voxel and LOD output must share a filesystem root for relative paths");
            }
            voxels.push_back(io::path_utf8(relative));
        }
        auto meta = io::read_json(path);
        if (voxels.empty()) {
            if (!meta.erase("voxels")) {
                continue;
            }
        } else {
            if (meta.contains("voxels") && same_voxel_paths(meta.at("voxels"), voxels)) {
                continue;
            }
            meta["voxels"] = std::move(voxels);
        }
        const auto text = meta.dump();
        io::write_bytes(path, { reinterpret_cast<const uint8_t*>(text.data()), text.size() });
    }
}
} // namespace splat_transform::pipeline
