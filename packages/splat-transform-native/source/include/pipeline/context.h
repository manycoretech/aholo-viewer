#pragma once
#include <cstdint>
#include <io/file.h>
#include <io/json.h>
#include <memory>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>
#include <voxel/voxel.h>

namespace splat_transform::pipeline {
using SplatPtr = std::shared_ptr<splat::Splat>;
struct SingleFile {
    std::string name;
    std::variant<SplatPtr, std::string> content;
    bool preserve_order = false;
};
using Resource = std::variant<SplatPtr, std::vector<SingleFile>>;

class TaskContext {
public:
    TaskContext();
    ~TaskContext();
    const Resource& input(const io::Json& config) const;
    const SplatPtr& splat_ptr(const io::Json& config) const;
    splat::Splat take_splat(const io::Json& config);
    splat::Splat select_splat(const io::Json& config, std::span<const uint32_t> indices);
    void set(const io::Json& config, Resource resource, bool inherit_grid = true);
    void geometry_changed(const io::Json& config);
    void begin_task(const io::Json& releases);
    void finish_task();
    void record_voxel(const io::Json& config);
    void record_lod_metadata(const io::Json& config, const std::filesystem::path& path);
    const voxel::Occupancy* find_grid(const io::Json& config, voxel::GridSpec requested) const;
    const voxel::Occupancy& store_grid(const io::Json& config, voxel::Occupancy&& grid);

private:
    struct Entry {
        Resource data;
        size_t source;
        size_t lineage;
    };
    struct ReadSource {
        size_t source_id;
        size_t root_lineage_id;
        uint64_t geometry_hash;
    };
    struct CachedVoxelGrid;
    void update_lod_metadata();
    std::unordered_map<std::string, Entry> resources_;
    std::unordered_set<std::string> releases_;
    size_t next_source_ = 0;
    std::unordered_map<uint64_t, ReadSource> read_sources_;
    // Only ancestors can supply a grid. A grid built on a filtered branch
    // cannot describe a sibling or the original input.
    std::vector<size_t> parents_;
    // Source ID -> grids produced by this source and its derived resources.
    std::unordered_map<size_t, std::vector<std::unique_ptr<CachedVoxelGrid>>> voxel_cache_;
    std::unordered_map<std::filesystem::path, size_t> voxel_outputs_;
    std::unordered_map<std::filesystem::path, size_t> lod_outputs_;
};
} // namespace splat_transform::pipeline
