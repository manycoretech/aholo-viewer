import { Context, BaseTask } from './BaseTask.js';
export interface Config {
    input: string;
    output: string;
    enableMortonSort?: boolean;
    compressLevel?: number;
    spzVersion?: number;
}
export declare class WriteTask extends BaseTask<Config> {
    exec(config: Config, { logger, resources }: Context): Promise<void>;
    requiresGPU(config: Config): boolean;
}
