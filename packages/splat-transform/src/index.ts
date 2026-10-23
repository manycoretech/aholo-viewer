import { execute, type RunOptions } from './process.js';
import type { DeviceInfo, PipelineConfig } from './pipeline.js';

export type {
    PipelineConfig,
    PipelineTask,
    TaskType,
    DeviceInfo,
    ModifyConfig,
    SelectConfig,
    ReplaceAppendConfig,
    ExtractLodLevelConfig,
    VoxelConfig,
} from './pipeline.js';
export { ApiType } from './pipeline.js';
export { PipelineError, resolveExecutable, type RunOptions } from './process.js';

/** Execute a JSON pipeline in the standalone C++ process. */
export async function run(config: PipelineConfig, options?: RunOptions): Promise<void> {
    const input = JSON.stringify(config);
    if (input === undefined) throw new TypeError('A pipeline object is required');
    await execute(['-'], { ...options, input });
}

/** List devices with API information and the global indices used by pipelines. */
export async function enumerateAdapters(options?: RunOptions): Promise<DeviceInfo[]> {
    return JSON.parse(await execute(['--list-gpu'], { ...options, capture: true }));
}
