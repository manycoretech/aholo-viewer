#include <pipeline/context.h>

namespace splat_transform::pipeline {
const Resource& TaskContext::input(const io::Json& config) const {
    return resources_.at(config.at("input").get<std::string>());
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
    resources_.insert_or_assign(config.at("output").get<std::string>(), std::move(resource));
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
} // namespace splat_transform::pipeline
