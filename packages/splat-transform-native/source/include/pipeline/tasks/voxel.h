#pragma once
#include <pipeline/task.h>

namespace splat_transform::pipeline {
class VoxelTask final : public BaseTask {
public:
    void exec(const io::Json& config, TaskContext& context) const override;
    bool requires_gpu(const io::Json& config, const TaskContext&) const override;
};
} // namespace splat_transform::pipeline
