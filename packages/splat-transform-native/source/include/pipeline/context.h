#pragma once
#include <cstdint>
#include <io/file.h>
#include <unordered_map>
#include <unordered_set>
#include <variant>

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
    const Resource& input(const io::Json& config) const;
    const SplatPtr& splat_ptr(const io::Json& config) const;
    splat::Splat take_splat(const io::Json& config);
    void set(const io::Json& config, Resource resource);
    void begin_task(const io::Json& releases);
    void finish_task();
    void record_voxel(const io::Json& config);
    void record_lod_metadata(const io::Json& config, const std::filesystem::path& path);

private:
    struct Entry {
        Resource data;
        size_t source;
    };
    void update_lod_metadata();
    std::unordered_map<std::string, Entry> resources_;
    std::unordered_set<std::string> releases_;
    size_t next_source_ = 0;
    std::unordered_map<uint64_t, size_t> read_sources_;
    std::unordered_map<std::filesystem::path, size_t> voxel_outputs_;
    std::unordered_map<std::filesystem::path, size_t> lod_outputs_;
};
} // namespace splat_transform::pipeline
