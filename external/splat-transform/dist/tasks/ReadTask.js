import fs from 'node:fs';
import { Readable } from 'node:stream';
import { SplatData } from '../SplatData.js';
import { createSplatFile } from '../utils/index.js';
import { BaseTask } from './BaseTask.js';
export class ReadTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { inputs, output, maxShDegree } = config;
        const splat = new SplatData(inputs.length, maxShDegree);
        const promises = [];
        let totalBytes = 0;
        for (let i = 0; i < inputs.length; i++) {
            const path = inputs[i];
            const { size } = fs.statSync(path);
            totalBytes += size;
            const stream = Readable.toWeb(fs.createReadStream(path));
            const promise = createSplatFile(path).read(stream, size, splat);
            promises.push(promise);
        }
        await Promise.all(promises);
        logger.info(`load: ${inputs.length} files | sizes=${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
        for (let i = 0; i < inputs.length; i++) {
            logger.info(`  - ${inputs[i]}`);
        }
        logger.info(`counts: ${splat.counts}, SH: ${splat.shDegree}`);
        resources.set(output, splat);
        logger.info(`stored -> "${output}"`);
    }
}
