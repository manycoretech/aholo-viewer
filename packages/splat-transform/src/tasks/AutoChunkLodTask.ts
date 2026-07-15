import type { SplatData } from '../SplatData.js';
import { combineSplatData, computeDenseBox } from '../utils/index.js';
import { type Context, BaseTask, type SingleFile } from './BaseTask.js';
import { generateSplatLod, SplitNormal, type LevelParameter } from '../native/index.js';

export interface Config {
    input: string;
    output: string;
    type: string;
    splitNormal?: SplitNormal | keyof typeof SplitNormal;
    maxChunkCounts?: number;
    levels?: LevelParameter[];
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

const DefaultLevels: LevelParameter[] = [
    { precision: 1.0, scaleBoost: 1 },
    { precision: 0.5, scaleBoost: 1 },
    { precision: 0.25, scaleBoost: 1 },
    { precision: 0.05, scaleBoost: 1.01 },
    { precision: 0.01, scaleBoost: 1.02 },
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

            const chunkL3Idx: number[] = [];
            const chunkL4Idx: number[] = [];
            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                chunkL4Idx.push(block.refs[4]);
                if (block.refs[3] !== block.refs[4]) {
                    chunkL3Idx.push(block.refs[3]);
                }
            }
            const layout = new Map<number, { idx: number; offset: number; counts: number }>();
            {
                const chunkL4 = combineSplatData(chunkL4Idx.map(idx => splats[idx]));
                outputs.push({ name: `chunk_0.${type}`, content: chunkL4, preserveOrder: true });
                permanentFiles.push(0);
                let offset = 0;
                for (let i = 0; i < chunkL4Idx.length; i++) {
                    const idx = chunkL4Idx[i];
                    const counts = splats[idx].counts;
                    layout.set(idx, { idx: 0, offset, counts });
                    offset += counts;
                }
            }
            if (chunkL3Idx.length > 0) {
                const chunkL3 = combineSplatData(chunkL3Idx.map(idx => splats[idx]));
                outputs.push({ name: `chunk_1.${type}`, content: chunkL3, preserveOrder: true });
                permanentFiles.push(1);
                let offset = 0;
                for (let i = 0; i < chunkL3Idx.length; i++) {
                    const idx = chunkL3Idx[i];
                    const counts = splats[idx].counts;
                    layout.set(idx, { idx: 1, offset, counts });
                    offset += counts;
                }
            }

            for (let i = 0; i < splats.length; i++) {
                if (chunkL3Idx.includes(i) || chunkL4Idx.includes(i)) {
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
