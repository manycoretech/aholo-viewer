import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { SplatData } from '../SplatData.js';
import {
    deferred,
    detectSplatFileType,
    SplatFileType,
    WorkerPool,
    writeSplatFile,
    type Deferred,
    type ISplatData,
} from '../utils/index.js';
import { type Context, BaseTask } from './BaseTask.js';

export interface Config {
    input: string;
    output: string;
    parallelCounts?: number;
    enableMortonSort?: boolean;
    compressLevel?: number;
    spzVersion?: number;
}

export class WriteTask extends BaseTask<Config> {
    override async exec(config: Config, { logger, resources }: Context) {
        const {
            input,
            output,
            parallelCounts = Math.max(1, os.cpus().length - 1),
            enableMortonSort = true,
            compressLevel,
            spzVersion,
        } = config;
        const pool = new WorkerPool(
            'splat-write',
            () => new Worker(new URL('./write_worker.js', import.meta.url)),
            parallelCounts,
        );

        const source = resources.get(input)!;
        if (source instanceof SplatData) {
            logger.info(`writing splat -> file="${output}" count=${source.counts} SH=${source.shDegree}`);
            await writeSplatFile(output, source, enableMortonSort, compressLevel, spzVersion);
            logger.info(`writing done`);
            return;
        }

        if (fs.existsSync(output)) {
            fs.rmSync(output, { recursive: true });
            logger.info(`exist dir ${output}, removed`);
        }
        fs.mkdirSync(output, { recursive: true });

        logger.info(`writing bundle -> dir="${output}" files=${source.length}`);
        logger.silent = true;
        const sogList: Array<{ name: string; content: SplatData }> = [];
        const promises: Array<Promise<void>> = [];
        let idx: number = 1;
        const totals = source.length;
        for (let i = 0; i < source.length; i++) {
            const { name, content, preserveOrder = false } = source[i];
            const filepath = path.join(output, name);
            if (typeof content === 'string') {
                logger.info(`- ${filepath} (${idx++}/${totals})`, true);
                fs.writeFileSync(filepath, content);
                continue;
            }
            const type = detectSplatFileType(filepath);
            if (type === SplatFileType.SOG) {
                sogList.push({ name, content: content as SplatData });
                continue;
            }

            logger.info(`- ${filepath} (${idx++}/${totals})`, true);
            const d = deferred();
            await runWriteTask(
                pool,
                {
                    filepath,
                    data: content.serialize(),
                    enableMortonSort: enableMortonSort && !preserveOrder,
                    compressLevel,
                    spzVersion,
                },
                d,
            );
            promises.push(d.promise);
        }
        await Promise.all(promises);
        await pool.dispose();
        for (let i = 0; i < sogList.length; i++) {
            const { name, content } = sogList[i];
            const filepath = path.join(output, name);
            logger.info(`- ${filepath} (${idx++}/${totals})`, true);
            await writeSplatFile(filepath, content, false);
        }
        logger.silent = false;
        logger.info(`writing bundle done -> dir="${output}" files=${source.length}`);
    }

    override requiresGPU(config: Config): boolean {
        return config.output.endsWith('sog');
    }
}

interface WriteWorkerTask {
    filepath: string;
    data: ISplatData;
    enableMortonSort: boolean;
    compressLevel: number | undefined;
    spzVersion: number | undefined;
}

function createWorkerError(filepath: string, reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }
    return new Error(`Write worker failed for "${filepath}": ${String(reason)}`);
}

async function runWriteTask(pool: WorkerPool, task: WriteWorkerTask, deferred: Deferred) {
    const worker = await pool.getWorker();

    const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
    };

    let settled = false;
    const finish = (error?: unknown, releaseWorker = true) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        if (releaseWorker) {
            worker.release();
        }
        if (error === undefined) {
            deferred.resolve();
        } else {
            deferred.reject(createWorkerError(task.filepath, error));
        }
    };

    const onMessage = (msg: unknown) => {
        const result = msg != null && typeof msg === 'object' ? (msg as any) : undefined;
        if (result?.success === true) {
            finish();
        } else {
            finish(result?.content ?? 'Worker returned a malformed response');
        }
    };

    const onError = (error: Error) => {
        finish(error, false);
        void worker.terminate();
    };

    const onExit = (code: number) => {
        finish(new Error(`Write worker exited with code ${code} before completing "${task.filepath}"`), false);
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);

    try {
        worker.postMessage(task, task.data.table.map(v => v.buffer) as any);
    } catch (error) {
        finish(error);
    }
}
