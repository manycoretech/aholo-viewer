import { SplitNormal, splitSplat } from '../native/index.js';
import type { SplatData } from '../SplatData.js';
import { type Context, BaseTask, type SingleFile } from './BaseTask.js';

export interface Config {
    input: string;
    output: string;
    type: string;
    splitNormal?: SplitNormal | keyof typeof SplitNormal;
    blockPrecision?: number;
}

export class SplitSplatTask extends BaseTask<Config> {
    override exec(config: Config, { logger, resources }: Context) {
        const { input, output, type, blockPrecision = 0.5, splitNormal = SplitNormal.None } = config;
        const splat = resources.get(input) as SplatData;
        logger.info(`loaded -> "${input}"`);
        logger.info(`block precision -> ${blockPrecision}`);
        logger.info('splitting splat');
        logger.time('split elapsed');
        const { splats } = splitSplat(
            splat,
            blockPrecision,
            typeof splitNormal === 'string' ? SplitNormal[splitNormal] : splitNormal,
        );
        logger.timeEnd('split elapsed');
        const outputs: SingleFile[] = [];
        for (let i = 0; i < splats.length; i++) {
            outputs.push({
                name: `block_${i}.${type}`,
                content: splats[i],
            });
        }

        resources.set(output, outputs);
        return Promise.resolve();
    }
}
