import { combineSplatData } from '../utils/index.js';
import { generateLod } from '../native/index.js';
import { BaseTask } from './BaseTask.js';
export class AutoLodTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { input, output, counts = Infinity, ratio = 0.3 } = config;
        const splat = resources.get(input);
        logger.info(`loaded -> "${input}"`);
        const target = Math.min(Math.ceil(splat.counts * ratio), counts);
        logger.info(`expected -> ${target}(${((target / splat.counts) * 100).toFixed(2)}%) | ratio=${ratio} counts=${counts}`);
        const { blocks, splats } = generateLod(splat, [
            { precision: 1.0, scaleBoost: 1.0 },
            { precision: target / splat.counts, scaleBoost: 1.0 },
        ], 0.2, 2000, 20);
        const raw = combineSplatData(blocks.map(item => splats[item.refs[1]]));
        logger.info(`result -> ${raw.counts}(${(raw.counts / target * 100).toFixed(2)}%)`);
        resources.set(output, raw);
        logger.info(`stored -> key="${output}"`);
    }
}
