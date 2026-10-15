#pragma once
#include <pipeline/task.h>

namespace splat_transform::pipeline {
class WriteTask final : public BaseTask {
public:
    void exec(const io::Json& config, TaskContext& context) const override;
    bool requires_gpu(const io::Json& config, const TaskContext& context) const override;
};
} // namespace splat_transform::pipeline
