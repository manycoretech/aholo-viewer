import { Context, BaseTask } from './BaseTask.js';
export interface Config {
    input: string;
    output: string;
    scorePath: string;
    counts?: number;
    ratio?: number;
    originalIndices?: string;
}
export declare class FlexLodTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
}
