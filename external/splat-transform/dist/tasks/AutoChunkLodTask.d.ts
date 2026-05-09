import { Context, BaseTask } from './BaseTask.js';
import { LevelParameter } from '../native/index.js';
export interface Config {
    input: string;
    output: string;
    type: string;
    maxChunkCounts?: number;
    levels?: LevelParameter[];
}
export declare class AutoChunkLodTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
    requiresGPU(config: Config): boolean;
}
