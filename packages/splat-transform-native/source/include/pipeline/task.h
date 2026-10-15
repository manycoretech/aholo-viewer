#pragma once
#include <pipeline/context.h>

namespace splat_transform::pipeline {
class BaseTask {
public:
    virtual ~BaseTask() = default;
    virtual void exec(const io::Json& config, TaskContext& context) const = 0;
    virtual bool requires_gpu(const io::Json&, const TaskContext&) const { return false; }
};
std::unique_ptr<BaseTask> create_task(std::string_view type);
} // namespace splat_transform::pipeline
