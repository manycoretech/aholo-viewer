import { Context, BaseTask } from './BaseTask.js';
export interface Config {
    input: string;
    output: string;
    modifyPaths?: string[];
}
export declare class ModifyTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
}
