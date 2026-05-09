import { SplatData } from '../SplatData.js';
import { Logger } from '../utils/Logger.js';
export interface SingleFile {
    name: string;
    content: SplatData | string;
    preserveOrder?: boolean;
}
export interface Context {
    logger: Logger;
    resources: Map<string, SplatData | SingleFile[]>;
}
export declare abstract class BaseTask<T> {
    abstract exec(config: T, ctx: Context): Promise<void>;
    requiresGPU(_config: T): boolean;
}
