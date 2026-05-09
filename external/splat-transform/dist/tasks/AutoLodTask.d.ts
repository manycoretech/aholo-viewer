import { Context, BaseTask } from './BaseTask.js';
export interface Config {
    input: string;
    output: string;
    counts?: number;
    ratio?: number;
}
export declare class AutoLodTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
}
