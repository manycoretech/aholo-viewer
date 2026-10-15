#pragma once
#include <pipeline/task.h>

namespace splat_transform::pipeline {
class AutoLodTask final : public BaseTask {
public:
    void exec(const io::Json& config, TaskContext& context) const override;
};
} // namespace splat_transform::pipeline
