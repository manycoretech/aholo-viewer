#include <pipeline/runner.h>
#include <pipeline/tasks/modify.h>
#include <utility/logger.h>
namespace splat_transform::pipeline {
using io::Json;
void ModifyTask::exec(const Json& config, TaskContext& context) const {
    auto data = context.splat_ptr(config);
    auto& logger = utility::logger();
    logger.info("loaded -> \"", config.at("input").get<std::string>(), '"');
    modify(*data, config);
    context.set(config, std::move(data));
    logger.info("stored -> key=\"", config.at("output").get<std::string>(), '"');
}
} // namespace splat_transform::pipeline
