import fs from 'node:fs';
import { Readable } from 'node:stream';
import { SplatData } from '../SplatData.js';
import { createSplatFile } from '../utils/index.js';
import { type Context, BaseTask } from './BaseTask.js';

export interface Config {
    inputs: string[];
    output: string;
    maxShDegree?: number;
}

export class ReadTask extends BaseTask<Config> {
    override async exec(config: Config, { logger, resources }: Context) {
        const { inputs, output, maxShDegree } = config;
        const splat = new SplatData(inputs.length, maxShDegree);
        const promises: Array<Promise<void>> = [];
        let totalBytes: number = 0;
        for (let i = 0; i < inputs.length; i++) {
            const path = inputs[i];
            const stat = fs.statSync(path);
            if (!stat.isFile()) {
                throw new Error(`Input must be a file: ${path}`);
            }
            const { size } = stat;
            totalBytes += size;
            const buffer = /\.zip$/i.test(path) ? fs.readFileSync(path) : undefined;
            const file = createSplatFile(path, buffer);
            const stream = Readable.toWeb(
                buffer ? Readable.from([buffer]) : fs.createReadStream(path),
            ) as ReadableStream<Uint8Array>;
            const promise = file.read(stream, size, splat);
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
