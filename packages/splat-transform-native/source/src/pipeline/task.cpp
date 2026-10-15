#include <pipeline/task.h>
#include <pipeline/tasks/auto_chunk_lod.h>
#include <pipeline/tasks/auto_lod.h>
#include <pipeline/tasks/extract_lod_level.h>
#include <pipeline/tasks/flex_lod.h>
#include <pipeline/tasks/modify.h>
#include <pipeline/tasks/read.h>
#include <pipeline/tasks/replace_append.h>
#include <pipeline/tasks/select.h>
#include <pipeline/tasks/skeleton_lod.h>
#include <pipeline/tasks/split_splat.h>
#include <pipeline/tasks/voxel.h>
#include <pipeline/tasks/write.h>

namespace splat_transform::pipeline {
namespace {
struct TaskType {
    std::string_view name;
    std::unique_ptr<BaseTask> (*create)();
};
template<typename T>
std::unique_ptr<BaseTask> make_task() { return std::make_unique<T>(); }
const std::array TASKS {
    TaskType { "Read", make_task<ReadTask> },
    TaskType { "Write", make_task<WriteTask> },
    TaskType { "Modify", make_task<ModifyTask> },
    TaskType { "Select", make_task<SelectTask> },
    TaskType { "ReplaceAppend", make_task<ReplaceAppendTask> },
    TaskType { "ExtractLodLevel", make_task<ExtractLodLevelTask> },
    TaskType { "SkeletonLod", make_task<SkeletonLodTask> },
    TaskType { "FlexLod", make_task<FlexLodTask> },
    TaskType { "AutoLod", make_task<AutoLodTask> },
    TaskType { "AutoChunkLod", make_task<AutoChunkLodTask> },
    TaskType { "SplitSplatTask", make_task<SplitSplatTask> },
    TaskType { "Voxel", make_task<VoxelTask> },
};
} // namespace
std::unique_ptr<BaseTask> create_task(std::string_view type) {
    const auto found = std::ranges::find(TASKS, type, &TaskType::name);
    if (found == TASKS.end()) {
        throw std::runtime_error("Unknown pipeline task: " + std::string(type));
    }
    return found->create();
}
} // namespace splat_transform::pipeline
