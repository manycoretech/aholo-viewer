import fs from 'node:fs';
import { SplatData } from '../SplatData.js';
import { BaseTask } from './BaseTask.js';
export class FlexLodTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { input, output, scorePath, counts = Infinity, ratio = 0.3, originalIndices } = config;
        const splat = resources.get(input);
        logger.info(`loaded -> "${input}"`);
        const target = Math.min(counts, Math.ceil(splat.counts * ratio));
        logger.info(`expected -> ${target}(${((target / splat.counts) * 100).toFixed(2)}%) | ratio=${ratio} counts=${counts}`);
        const scores = new Float32Array(fs.readFileSync(scorePath).buffer);
        let sorted = new Uint32Array(splat.counts);
        for (let i = 0; i < sorted.length; i++) {
            sorted[i] = i;
        }
        sorted.sort((a, b) => scores[b] - scores[a]);
        sorted = sorted.subarray(0, target).sort((a, b) => a - b);
        const raw = new SplatData().init(target, splat.shDegree);
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: new Array(splat.shCounts),
        };
        const shN = single.shN;
        for (let i = 0; i < target; i++) {
            splat.get(sorted[i], single);
            splat.getShN(sorted[i], shN);
            raw.set(i, single);
            raw.setShN(i, shN);
        }
        if (originalIndices) {
            const originIndices = new Uint32Array(target);
            for (let i = 0; i < target; i++) {
                originIndices[i] = sorted[i];
            }
            fs.writeFileSync(originalIndices, originIndices);
            logger.info(`original indices saved -> "${originalIndices}"`);
        }
        resources.set(output, raw);
        logger.info(`stored -> key="${output}"`);
    }
}
