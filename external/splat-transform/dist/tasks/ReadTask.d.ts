import { Context, BaseTask } from './BaseTask.js';
export interface Config {
    inputs: string[];
    output: string;
    maxShDegree?: number;
}
export declare class ReadTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
}
