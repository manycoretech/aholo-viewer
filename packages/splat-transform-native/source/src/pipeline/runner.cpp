#include <gpu/context.h>
#include <pipeline/runner.h>
#include <pipeline/task.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::pipeline {
void run(const io::Json& pipeline) {
    if (!pipeline.is_object() || pipeline.value("version", 1) != 1 || !pipeline.contains("tasks") || !pipeline.at("tasks").is_array()) {
        throw std::runtime_error("Expected a version 1 pipeline with a tasks array");
    }
    if (pipeline.contains("cpuWorkers")) {
        const auto& workers = pipeline.at("cpuWorkers");
        if (!workers.is_number_integer() ||
            (workers.is_number_unsigned() ? workers.get<uint64_t>() == 0 : workers.get<int64_t>() <= 0)) {
            throw std::runtime_error("cpuWorkers must be a positive integer");
        }
        threading::configure_default_pool(workers.get<size_t>());
    }
    // Destroy all tasks and their resources before the owning GPU scope.
    gpu::DeviceGuard device_guard;
    std::vector<std::unique_ptr<BaseTask>> tasks;
    for (const auto& task : pipeline.at("tasks")) {
        tasks.push_back(create_task(task.at("type").get<std::string>()));
    }
    auto& logger = utility::logger();
    auto pipeline_log = logger.scope("");
    auto total_time = logger.time("Total elapsed time");
    {
        auto cpu_log = logger.scope("[Task:CPU]");
        logger.info("CPU workers: ", threading::default_thread_count());
    }
    TaskContext context;
    bool gpu_selected = false;
    for (size_t i = 0; i < tasks.size(); ++i) {
        const auto& spec = pipeline.at("tasks")[i];
        const auto config = spec.value("config", io::Json::object());
        context.begin_task(spec.value("release", io::Json::array()));
        if (!gpu_selected && tasks[i]->requires_gpu(config, context)) {
            auto gpu_log = logger.scope("[Task:GPU]");
            auto gpu_index = pipeline.value("gpu", uint32_t(0));
            logger.info("Any task requires GPU detected, initialize GPU adapter: ", gpu_index, ".");
            gpu::select_device(gpu_index);
            gpu_selected = true;
        }
        auto task_log = logger.scope("[Task:" + spec.at("type").get<std::string>() + '#' + spec.value("id", "") + ']');
        auto elapsed = logger.time("elapsed time");
        tasks[i]->exec(config, context);
        context.finish_task();
    }
}
} // namespace splat_transform::pipeline
