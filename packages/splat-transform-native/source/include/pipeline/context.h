#pragma once
#include <io/file.h>
#include <set>
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

private:
    std::map<std::string, Resource> resources_;
    std::set<std::string> releases_;
};
} // namespace splat_transform::pipeline
