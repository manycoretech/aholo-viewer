import type { SplatData } from '../SplatData.js';
import { combineSplatData, computeDenseBox } from '../utils/index.js';
import { type Context, BaseTask, type SingleFile } from './BaseTask.js';
import { generateSplatLod, SplitNormal, type LevelParameter } from '../native/index.js';

export interface ChunkLevelParameter extends LevelParameter {
    permanent?: boolean;
    merged?: boolean;
}

export interface Config {
    input: string;
    output: string;
    type: string;
    splitNormal?: SplitNormal | keyof typeof SplitNormal;
    maxChunkCounts?: number;
    levels?: ChunkLevelParameter[];
}

interface OutputBlock {
    bound: {
        max: [number, number, number];
        min: [number, number, number];
    };
    lods: Array<{
        file: number;
        offset: number;
        count: number;
    }>;
}

const DefaultLevels: ChunkLevelParameter[] = [
    { precision: 1.0, scaleBoost: 1 },
    { precision: 0.5, scaleBoost: 1 },
    { precision: 0.25, scaleBoost: 1 },
    { precision: 0.05, scaleBoost: 1.01, permanent: true, merged: true },
    { precision: 0.01, scaleBoost: 1.02, permanent: true, merged: true },
];

export class AutoChunkLodTask extends BaseTask<Config> {
    override async exec(config: Config, { logger, resources }: Context) {
        const {
            input,
            output,
            type,
            maxChunkCounts = 400000,
            levels = DefaultLevels,
            splitNormal = SplitNormal.None,
        } = config;
        const inputData = resources.get(input);
        // TODO: array support...
        const splat = Array.isArray(inputData) ? (inputData[0].content as SplatData) : (inputData as SplatData);
        logger.info(`loaded -> "${input}"`);
        const forwardBox = computeDenseBox(splat, 0.8);

        const outputs: SingleFile[] = [];
        const outputBlocks: OutputBlock[] = [];
        const permanentFiles: number[] = [];
        {
            logger.info('generate lod');
            logger.time('generate elapsed');
            const { blocks, splats } = generateSplatLod(
                splat,
                levels,
                Math.min(1, maxChunkCounts / splat.counts),
                typeof splitNormal === 'string' ? SplitNormal[splitNormal] : splitNormal,
                2000,
                20,
            );
            logger.timeEnd('generate elapsed');

            const layout = new Map<number, { idx: number; offset: number; counts: number }>();

            for (let levelIdx = levels.length - 1; levelIdx >= 0; levelIdx--) {
                if (!levels[levelIdx].merged) {
                    continue;
                }

                const refs = [...new Set(blocks.map(block => block.refs[levelIdx]))].filter(ref => !layout.has(ref));
                if (refs.length === 0) {
                    continue;
                }

                const idx = outputs.length;
                outputs.push({
                    name: `chunk_${idx}.${type}`,
                    content: combineSplatData(refs.map(ref => splats[ref])),
                    preserveOrder: true,
                });
                let offset = 0;
                for (const ref of refs) {
                    const counts = splats[ref].counts;
                    layout.set(ref, { idx, offset, counts });
                    offset += counts;
                }
            }

            for (let i = 0; i < splats.length; i++) {
                if (layout.has(i)) {
                    continue;
                }
                const idx = outputs.length;
                const splat = splats[i];
                outputs.push({
                    name: `chunk_${idx}.${type}`,
                    content: splat,
                });
                layout.set(i, { idx, offset: 0, counts: splat.counts });
            }
            for (const block of blocks) {
                outputBlocks.push({
                    bound: block.box,
                    lods: block.refs.map(ref => {
                        const v = layout.get(ref)!;
                        return {
                            file: v.idx,
                            offset: v.offset,
                            count: v.counts,
                        };
                    }),
                });
            }

            const permanentFileSet = new Set<number>();
            for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
                if (!levels[levelIdx].permanent) {
                    continue;
                }
                for (const block of blocks) {
                    permanentFileSet.add(layout.get(block.refs[levelIdx])!.idx);
                }
            }
            for (let i = 0; i < outputs.length; i++) {
                if (permanentFileSet.has(i)) {
                    permanentFiles.push(i);
                }
            }
        }

        logger.info(`Total blocks: ${outputBlocks.length}, files: ${outputs.length}`);
        logger.info(`Gaussian per level: `);
        let maxLength = 0;
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            const levelCount = outputBlocks.map(block => block.lods[i].count).reduce((acc, i) => acc + i, 0);
            const levelStr = levelCount.toString().padStart(maxLength, ' ');
            maxLength = levelStr.length;
            logger.info(
                `\tLevel ${i}${`(${(level.precision * 100).toFixed(2)}%)`.padStart(9, ' ')}: ${levelStr}${`(${((levelCount / splat.counts) * 100).toFixed(2)}%)`.padStart(9, ' ')}`,
            );
        }

        resources.set(output, [
            {
                name: 'lod-meta.json',
                content: JSON.stringify({
                    magicCode: 0x262834,
                    type: 'lod-splat',
                    version: '1.0',
                    counts: splat.counts,
                    shDegree: splat.shDegree,
                    levels: levels.length,
                    forwardBox,
                    files: outputs.map(f => f.name),
                    permanentFiles,
                    tree: outputBlocks,
                }),
            },
            ...outputs,
        ]);
    }

    override requiresGPU(config: Config): boolean {
        return config.type === 'sog';
    }
}
