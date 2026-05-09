import { AutoChunkLodTask } from './tasks/AutoChunkLodTask.js';
import { AutoLodTask } from './tasks/AutoLodTask.js';
import { FlexLodTask } from './tasks/FlexLodTask.js';
import { SkeletonLodTask } from './tasks/SkeletonLodTask.js';
import { ModifyTask } from './tasks/ModifyTask.js';
import { ReadTask } from './tasks/ReadTask.js';
import { WriteTask } from './tasks/WriteTask.js';
import { VoxelTask } from './tasks/VoxelTask.js';
import { enumerateAdapters, logger, releaseSharedDevice, initGPUAdapter } from './utils/index.js';
const TaskMap = {
    Read: new ReadTask(),
    Write: new WriteTask(),
    Voxel: new VoxelTask(),
    Modify: new ModifyTask(),
    SkeletonLod: new SkeletonLodTask(),
    FlexLod: new FlexLodTask(),
    AutoLod: new AutoLodTask(),
    AutoChunkLod: new AutoChunkLodTask(),
};
function anyTaskRequireGPU(tasks) {
    for (const t of tasks) {
        if (TaskMap[t.type].requiresGPU(t.config)) {
            return true;
        }
    }
    return false;
}
export async function runner(config) {
    console.time('Total elapsed time');
    const ctx = {
        logger,
        resources: new Map(),
    };
    if (anyTaskRequireGPU(config.tasks)) {
        logger.prefix = `[Task:GPU]`;
        logger.info('Any task requires GPU detected, initialize GPU adapter.');
        const adapter = (await enumerateAdapters())[config.gpu ?? 0];
        initGPUAdapter([`adapter=${adapter.name}`]);
    }
    for (const taskDef of config.tasks) {
        const { id, type, config: taskConfig, release = [] } = taskDef;
        const task = TaskMap[type];
        if (!task) {
            throw new Error(`Task not found: ${type} (id: ${id})`);
        }
        logger.prefix = `[Task:${type}#${id}]`;
        logger.time('elapsed time');
        await task.exec(taskConfig, ctx);
        release.forEach(v => ctx.resources.delete(v));
        logger.timeEnd('elapsed time');
    }
    releaseSharedDevice();
    console.timeEnd('Total elapsed time');
}
