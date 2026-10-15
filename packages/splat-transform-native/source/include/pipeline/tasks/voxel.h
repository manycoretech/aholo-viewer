#pragma once
#include <pipeline/task.h>

namespace splat_transform::pipeline {
class VoxelTask final : public BaseTask {
public:
    void exec(const io::Json& config, TaskContext& context) const override;
    bool requires_gpu(const io::Json&, const TaskContext&) const override { return true; }
};
} // namespace splat_transform::pipeline
