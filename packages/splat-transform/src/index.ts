import { execute, type RunOptions } from './process.js';
import type { PipelineConfig, VulkanAdapter } from './pipeline.js';

export type {
    PipelineConfig,
    PipelineTask,
    TaskType,
    VulkanAdapter,
    ModifyConfig,
    SelectConfig,
    ReplaceAppendConfig,
    ExtractLodLevelConfig,
    VoxelConfig,
} from './pipeline.js';
export { PipelineError, resolveExecutable, type RunOptions } from './process.js';

/** Execute a JSON pipeline in the standalone C++ process. */
export async function run(config: PipelineConfig, options?: RunOptions): Promise<void> {
    const input = JSON.stringify(config);
    if (input === undefined) throw new TypeError('A pipeline object is required');
    await execute(['-'], { ...options, input });
}

/** List Vulkan devices using the same backend and indices as pipeline execution. */
export async function enumerateAdapters(options?: RunOptions): Promise<VulkanAdapter[]> {
    return JSON.parse(await execute(['--list-gpu'], { ...options, capture: true }));
}
