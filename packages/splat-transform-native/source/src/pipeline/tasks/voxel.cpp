#include <pipeline/tasks/voxel.h>
#include <utility/logger.h>
#include <voxel/voxel.h>
namespace splat_transform::pipeline {
using io::Json;
bool VoxelTask::requires_gpu(const Json& config, const TaskContext&) const {
    return voxel::requires_gpu(config);
}
void VoxelTask::exec(const Json& config, TaskContext& context) const {
    const auto& data = *context.splat_ptr(config);
    const auto output = io::utf8_path(config.at("output").get<std::string>());
    auto& logger = utility::logger();
    logger.info("writing voxel -> dir=\"", io::path_utf8(output), "\" count=", data.size(), " SH=", data.sh_degree);
    voxel::write(data, output, config);
    context.record_voxel(config);
    logger.info("voxelizing done");
}
} // namespace splat_transform::pipeline
