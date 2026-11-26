#include <algorithm>
#include <array>
#include <limits>
#include <memory>
#include <new>
#include <pipeline/context.h>
#include <span>
#include <string_view>
#include <utility/parallel.h>
#include <voxel/grid.h>
#include <xxhash.h>

namespace splat_transform::pipeline {
namespace {
constexpr size_t NO_LINEAGE = std::numeric_limits<size_t>::max();

uint64_t ordered_input_key(const io::Json& inputs, const PathResolver& paths) {
    auto hash = std::unique_ptr<XXH3_state_t, decltype(&XXH3_freeState)>(XXH3_createState(), &XXH3_freeState);
    if (!hash) {
        throw std::bad_alloc();
    }
    XXH3_64bits_reset(hash.get());
    for (const auto& input : inputs) {
        const auto path = paths.resolve(input.get<std::string>());
        const auto bytes = std::as_bytes(std::span(path.native()));
        XXH64_canonical_t length;
        XXH64_canonicalFromHash(&length, bytes.size());
        XXH3_64bits_update(hash.get(), &length, sizeof(length));
        XXH3_64bits_update(hash.get(), bytes.data(), bytes.size());
    }
    return XXH3_64bits_digest(hash.get());
}

// Hash decoded occupancy inputs. Multi-file formats can change even when the
// manifest and its timestamp are identical. SH and object padding are irrelevant.
uint64_t geometry_hash(const splat::Splat& data) {
    constexpr size_t chunk_size = 256;
    std::vector<uint64_t> chunks((data.size() + chunk_size - 1) / chunk_size);
    threading::parallel_chunks(chunks.size(), 16, [&](size_t begin, size_t end) {
        std::array<float, chunk_size * 11> buffer;
        for (size_t chunk = begin; chunk < end; ++chunk) {
            auto* out = buffer.data();
            for (const auto& point : std::span(data.gaussians)
                     .subspan(chunk * chunk_size, std::min(chunk_size, data.size() - chunk * chunk_size))) {
                out = std::copy_n(point.mean.data(), 3, out);
                out = std::copy_n(point.scale.data(), 3, out);
                out = std::copy_n(point.rotation.coeffs().data(), 4, out);
                *out++ = point.opacity;
            }
            chunks[chunk] = XXH3_64bits(buffer.data(), (out - buffer.data()) * sizeof(float));
        }
    });
    return XXH3_64bits(chunks.data(), chunks.size() * sizeof(uint64_t));
}

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
struct TaskContext::CachedVoxelGrid {
    size_t lineage;
    voxel::Occupancy occupancy;
};
TaskContext::TaskContext(PathResolver resolver) : paths(std::move(resolver)) {}
TaskContext::~TaskContext() = default;
const Resource& TaskContext::input(const io::Json& config) const {
    return this->resources_.at(config.at("input").get<std::string>()).data;
}
const SplatPtr& TaskContext::splat_ptr(const io::Json& config) const {
    const auto& resource = this->input(config);
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
    const auto& pointer = this->splat_ptr(config);
    const auto name = config.at("input").get<std::string>();
    const bool disposable = config.value("output", "") == name || this->releases_.contains(name);
    // Retained resources and aliases remain valid. A replaced/released sole owner
    // can transfer its Gaussian and SH allocations directly into the task.
    if (disposable && pointer.use_count() == 1) {
        return std::move(*pointer);
    }
    return *pointer;
}
splat::Splat TaskContext::select_splat(const io::Json& config, std::span<const uint32_t> indices) {
    const auto& pointer = this->splat_ptr(config);
    const auto name = config.at("input").get<std::string>();
    if ((config.at("output") == name || this->releases_.contains(name)) && pointer.use_count() == 1) {
        return std::move(*pointer).select(indices);
    }
    return pointer->select(indices);
}
void TaskContext::geometry_changed(const io::Json& config) {
    const auto* changed = this->splat_ptr(config).get();
    const auto lineage = this->parents_.size();
    this->parents_.push_back(NO_LINEAGE);
    for (auto& [key, entry] : this->resources_) {
        if (auto* point = std::get_if<SplatPtr>(&entry.data); point && point->get() == changed) {
            entry.lineage = lineage;
        }
    }
}
void TaskContext::set(const io::Json& config, Resource resource, bool inherit_grid) {
    size_t source;
    size_t lineage = this->parents_.size();
    size_t parent = NO_LINEAGE;
    if (config.contains("input")) {
        const auto& input = this->resources_.at(config.at("input").get<std::string>());
        source = input.source;
        if (inherit_grid) {
            parent = input.lineage;
            const auto* data = std::get_if<SplatPtr>(&resource);
            const auto* original = std::get_if<SplatPtr>(&input.data);
            if (data && original && *data == *original) {
                lineage = parent;
            }
        }
    } else if (config.contains("inputs")) {
        const auto signature = geometry_hash(*std::get<SplatPtr>(resource));
        auto [entry, inserted] = this->read_sources_.try_emplace(
            ordered_input_key(config.at("inputs"), this->paths),
            ReadSource { this->next_source_, NO_LINEAGE, signature }
        );
        if (inserted) {
            ++this->next_source_;
        }
        auto& read = entry->second;
        if (read.root_lineage_id == NO_LINEAGE || read.geometry_hash != signature) {
            this->parents_.push_back(NO_LINEAGE);
            read.root_lineage_id = this->parents_.size() - 1;
            read.geometry_hash = signature;
        }
        source = read.source_id;
        lineage = read.root_lineage_id;
    } else {
        source = this->next_source_++;
    }
    if (lineage == this->parents_.size()) {
        this->parents_.push_back(parent);
    }
    this->resources_.insert_or_assign(
        config.at("output").get<std::string>(), Entry { std::move(resource), source, lineage }
    );
}
const voxel::Occupancy* TaskContext::find_grid(const io::Json& config, voxel::GridSpec requested) const {
    const auto& input = this->resources_.at(config.at("input").get<std::string>());
    const auto source = this->voxel_cache_.find(input.source);
    if (source == this->voxel_cache_.end()) {
        return nullptr;
    }
    const voxel::Occupancy* best = nullptr;
    for (auto node = input.lineage; node != NO_LINEAGE; node = this->parents_[node]) {
        for (const auto& entry : source->second) {
            const auto& grid = entry->occupancy;
            if (entry->lineage != node || grid.spec.opacity_cutoff != requested.opacity_cutoff) {
                continue;
            }
            if (grid.spec.voxel_resolution == requested.voxel_resolution) {
                return &grid;
            }
            if (grid.spec.voxel_resolution < requested.voxel_resolution &&
                (!best || grid.spec.voxel_resolution > best->spec.voxel_resolution)) {
                best = &grid;
            }
        }
    }
    return best;
}
const voxel::Occupancy& TaskContext::store_grid(const io::Json& config, voxel::Occupancy&& grid) {
    const auto& input = this->resources_.at(config.at("input").get<std::string>());
    auto& cached_grids = this->voxel_cache_[input.source];
    for (const auto& entry : cached_grids) {
        if (entry->lineage == input.lineage && entry->occupancy.spec == grid.spec) {
            return entry->occupancy;
        }
    }
    const auto& entry = cached_grids.emplace_back(
        std::make_unique<CachedVoxelGrid>(CachedVoxelGrid { input.lineage, std::move(grid) })
    );
    return entry->occupancy;
}
void TaskContext::begin_task(const io::Json& releases) {
    this->releases_.clear();
    for (const auto& name : releases) {
        this->releases_.insert(name.get<std::string>());
    }
}
void TaskContext::finish_task() {
    for (const auto& name : this->releases_) {
        this->resources_.erase(name);
    }
    this->releases_.clear();
}
void TaskContext::record_voxel(const io::Json& config) {
    const auto path = this->paths.resolve(config.at("output").get<std::string>()) / "voxel-meta.json";
    this->voxel_outputs_.insert_or_assign(path, this->resources_.at(config.at("input").get<std::string>()).source);
    this->update_lod_metadata();
}
void TaskContext::record_lod_metadata(const io::Json& config, const std::filesystem::path& path) {
    this->lod_outputs_.insert_or_assign(
        std::filesystem::absolute(path).lexically_normal(),
        this->resources_.at(config.at("input").get<std::string>()).source
    );
    this->update_lod_metadata();
}
void TaskContext::update_lod_metadata() {
    // Output directories can be replaced by later Write tasks. Never keep links
    // to deleted files or update metadata belonging to a previous output.
    const auto missing = [](const auto& output) { return !std::filesystem::is_regular_file(output.first); };
    std::erase_if(this->voxel_outputs_, missing);
    std::erase_if(this->lod_outputs_, missing);
    for (const auto& [path, source] : this->lod_outputs_) {
        auto voxels = io::Json::array();
        for (const auto& [voxel, voxel_source] : this->voxel_outputs_) {
            if (voxel_source != source) {
                continue;
            }
            const auto relative = voxel.lexically_relative(path.parent_path());
            if (relative.empty()) {
                throw std::runtime_error("Voxel and LOD output must share a filesystem root for relative paths");
            }
            voxels.push_back(relative.generic_u8string());
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
        io::write_bytes(path, std::as_bytes(std::span(text)));
    }
}
} // namespace splat_transform::pipeline
