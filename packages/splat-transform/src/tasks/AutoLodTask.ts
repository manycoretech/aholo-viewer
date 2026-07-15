import type { SplatData } from '../SplatData.js';
import { combineSplatData } from '../utils/index.js';
import { generateSplatLod, SplitNormal } from '../native/index.js';
import { type Context, BaseTask } from './BaseTask.js';

export interface Config {
    input: string;
    output: string;
    splitNormal?: SplitNormal | keyof typeof SplitNormal;
    counts?: number;
    ratio?: number;
}

export class AutoLodTask extends BaseTask<Config> {
    override async exec(config: Config, { logger, resources }: Context) {
        const { input, output, counts = Infinity, ratio = 0.3, splitNormal = SplitNormal.None } = config;
        const inputData = resources.get(input);
        // TODO: array support...
        const splat = Array.isArray(inputData) ? (inputData[0].content as SplatData) : (inputData as SplatData);
        logger.info(`loaded -> "${input}"`);
        const target = Math.min(Math.ceil(splat.counts * ratio), counts);
        logger.info(
            `expected -> ${target}(${((target / splat.counts) * 100).toFixed(2)}%) | ratio=${ratio} counts=${counts}`,
        );
        const { blocks, splats } = generateSplatLod(
            splat,
            [
                { precision: 1.0, scaleBoost: 1.0 },
                { precision: target / splat.counts, scaleBoost: 1.0 },
            ],
            0.2,
            typeof splitNormal === 'string' ? SplitNormal[splitNormal] : splitNormal,
            2000,
            20,
        );
        const raw = combineSplatData(blocks.map(item => splats[item.refs[1]]));
        logger.info(`result -> ${raw.counts}(${((raw.counts / target) * 100).toFixed(2)}%)`);
        resources.set(output, raw);
        logger.info(`stored -> key="${output}"`);
    }
}
