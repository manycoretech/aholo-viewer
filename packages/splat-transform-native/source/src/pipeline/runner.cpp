#include <gpu/context.h>
#include <pipeline/runner.h>
#include <pipeline/task.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
void run(const io::Json& pipeline) {
    if (!pipeline.is_object() || pipeline.value("version", 1) != 1 || !pipeline.contains("tasks") || !pipeline.at("tasks").is_array()) {
        throw std::runtime_error("Expected a version 1 pipeline with a tasks array");
    }
    std::vector<std::unique_ptr<BaseTask>> tasks;
    for (const auto& task : pipeline.at("tasks")) {
        tasks.push_back(create_task(task.at("type").get<std::string>()));
    }
    auto& logger = utility::logger();
    auto pipeline_log = logger.scope("");
    auto total_time = logger.time("Total elapsed time");
    gpu::DeviceGuard device_guard;
    TaskContext context;
    bool gpu_selected = false;
    for (size_t i = 0; i < tasks.size(); ++i) {
        const auto& spec = pipeline.at("tasks")[i];
        const auto config = spec.value("config", io::Json::object());
        context.begin_task(spec.value("release", io::Json::array()));
        if (!gpu_selected && tasks[i]->requires_gpu(config, context)) {
            auto gpu_log = logger.scope("[Task:GPU]");
            logger.info("Any task requires GPU detected, initialize GPU adapter.");
            gpu::select_device(pipeline.value("gpu", uint32_t(0)));
            gpu_selected = true;
        }
        auto task_log = logger.scope("[Task:" + spec.at("type").get<std::string>() + '#' + spec.value("id", "") + ']');
        auto elapsed = logger.time("elapsed time");
        tasks[i]->exec(config, context);
        context.finish_task();
    }
}
} // namespace splat_transform::pipeline
