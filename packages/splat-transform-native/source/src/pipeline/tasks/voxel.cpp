#include <pipeline/tasks/voxel.h>
#include <utility/logger.h>
#include <voxel/voxel.h>
namespace splat_transform::pipeline {
using io::Json;
void VoxelTask::exec(const Json& config, TaskContext& context) const {
    const auto& data = *context.splat_ptr(config);
    const auto output = config.at("output").get<std::string>();
    auto& logger = utility::logger();
    logger.info("writing voxel -> dir=\"", output, "\" count=", data.size(), " SH=", data.sh_degree);
    voxel::write(data, io::utf8_path(output), config);
    context.record_voxel(config);
    logger.info("voxelizing done");
}
} // namespace splat_transform::pipeline
