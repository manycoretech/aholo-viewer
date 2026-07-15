import { createRequire } from 'node:module';
import { SplatData } from '../SplatData.js';
import { Buffer } from 'node:buffer';
import { getNativePackageName } from './utils.js';

export enum SplitNormal {
    None,
    X,
    Y,
    Z,
}

declare namespace NativeModule {
    interface SplatLodResult {
        /**
         * block bounding box, blocks.
         */
        blockBoxes: Buffer;
        /**
         * size, blocks * levels, splat reference index of block's level, level orders.
         * eg. [b0_l0, b0_l1, b0_l2, ....]
         */
        blockRefs: Buffer;
        /**
         * each splat gaussian count.
         */
        gaussianCount: Buffer;
        /**
         * splat data table
         */
        data: Float32Array[];
    }

    interface SplatSplitResult {
        /**
         * block bounding box, blocks.
         */
        blockBoxes: Buffer;
        /**
         * each splat gaussian count.
         */
        gaussianCount: Buffer;
        /**
         * splat data table
         */
        data: Float32Array[];
    }

    class ThreadPool {
        readonly threadCount: number;
        readonly taskCount: number;
        constructor(threadCount?: number);
    }
    export interface Module {
        ThreadPool: typeof ThreadPool;
        generate_splat_lod(
            data: Buffer[],
            shSize: number,
            parameters: Buffer,
            blockPrecision: number,
            splitNormal: SplitNormal,
            minSize: number,
            maxStep: number,
            threadPool: ThreadPool,
        ): SplatLodResult;
        split_splat(
            data: Buffer[],
            shSize: number,
            blockPrecision: number,
            splitNormal: SplitNormal,
            threadPool: ThreadPool,
        ): SplatSplitResult;
        webp_encode_rgba(color: Buffer, width: number, height: number, quality: number): Buffer;
        webp_encode_rgba_lossless(color: Buffer, width: number, height: number): Buffer;
        webp_decode_rgba(data: Buffer): {
            data: Buffer;
            width: number;
            height: number;
        };
        avif_encode_rgba(color: Buffer, width: number, height: number, quality: number): Buffer;
        avif_encode_rgba_batched(
            data: Array<{ data: Buffer; width: number; height: number; quality: number }>,
            threadPool: ThreadPool,
        ): Buffer[];
        avif_decode_rgba(data: Buffer): {
            data: Buffer;
            width: number;
            height: number;
        };
        avif_decode_rgba_batched(
            data: Buffer[],
            threadPool: ThreadPool,
        ): Array<{
            data: Buffer;
            width: number;
            height: number;
        }>;
        cluster_average(
            data_table: Buffer[],
            labels: Buffer,
            k: number,
            output: Buffer[],
            threadPool: ThreadPool,
        ): void;
    }
}

const getModule = (function () {
    let m: NativeModule.Module | undefined = undefined;
    const require = createRequire(import.meta.url);
    const binaryModule = getNativePackageName() + '/splat-transform.node';

    return function () {
        if (!m) {
            m = require(binaryModule);
        }
        return m!;
    };
})();

const [defaultThreadPool, smallThreadPool] = (function () {
    let defaultTheadPool: NativeModule.ThreadPool | undefined;
    let smallTheadPool: NativeModule.ThreadPool | undefined;
    return [
        function () {
            if (!defaultTheadPool) {
                defaultTheadPool = new (getModule().ThreadPool)();
            }
            return defaultTheadPool;
        },
        function () {
            if (!smallTheadPool) {
                smallTheadPool = new (getModule().ThreadPool)(4);
            }
            return smallTheadPool;
        },
    ];
})();

export interface LevelParameter {
    precision: number;
    scaleBoost: number;
}

export interface BlockedSplats {
    box: {
        min: [number, number, number];
        max: [number, number, number];
    };
    /**
     * current block referenced splats, level ordered.
     */
    refs: number[];
}

export interface BlockedResult {
    splats: SplatData[];
    blocks: BlockedSplats[];
}

export function generateSplatLod(
    splat: SplatData,
    levelParameters: LevelParameter[],
    blockPrecision: number,
    splitNormal: number,
    minSize: number,
    maxStep: number,
): BlockedResult {
    if (splat.counts === 0) {
        return {
            splats: [splat],
            blocks: [
                {
                    box: { min: [0, 0, 0], max: [0, 0, 0] },
                    refs: new Array(levelParameters.length).fill(0),
                },
            ],
        };
    }
    const levels = levelParameters.length;
    const inputBuffers = splat.table.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    const buffer = Buffer.alloc(levels * 8);
    {
        const parameters = new Float32Array(buffer.buffer, buffer.byteOffset, levels * 2);
        for (let i = 0; i < levelParameters.length; i++) {
            const { precision, scaleBoost } = levelParameters[i];
            parameters[i * 2] = precision;
            parameters[i * 2 + 1] = scaleBoost;
        }
    }
    const { blockBoxes, blockRefs, gaussianCount, data } = getModule().generate_splat_lod(
        inputBuffers,
        splat.shCounts,
        buffer,
        blockPrecision,
        splitNormal,
        minSize,
        maxStep,
        defaultThreadPool(),
    );
    const blockView = new Float32Array(blockBoxes.buffer, blockBoxes.byteOffset, blockBoxes.byteLength / 4);
    const blockRefsView = new Uint32Array(blockRefs.buffer, blockRefs.byteOffset, blockRefs.byteLength / 4);
    const blockCount = blockView.length / 6;
    const gaussianCountView = new Uint32Array(
        gaussianCount.buffer,
        gaussianCount.byteOffset,
        gaussianCount.byteLength / 4,
    );
    const blocks: BlockedSplats[] = [];
    const splats: SplatData[] = [];

    // read splats
    {
        for (let i = 0; i < gaussianCountView.length; i++) {
            const count = gaussianCountView[i];
            const splatData = new SplatData(1, splat.shDegree);
            splatData.shDegree = splat.shDegree;
            splatData.shCounts = splat.shCounts;
            splatData.counts = count;
            splatData.table = data.slice(i * splat.table.length, i * splat.table.length + splat.table.length);
            splats.push(splatData);
        }
    }

    for (let i = 0; i < blockCount; i++) {
        const block: BlockedSplats = {
            box: {
                min: [blockView[i * 6], blockView[i * 6 + 1], blockView[i * 6 + 2]],
                max: [blockView[i * 6 + 3], blockView[i * 6 + 4], blockView[i * 6 + 5]],
            },
            refs: Array.from(blockRefsView.subarray(i * levels, i * levels + levels)),
        };
        blocks.push(block);
    }

    return { splats, blocks };
}

export function splitSplat(splat: SplatData, blockPrecision: number, splitNormal: SplitNormal): BlockedResult {
    if (splat.counts === 0) {
        return {
            splats: [splat],
            blocks: [
                {
                    box: { min: [0, 0, 0], max: [0, 0, 0] },
                    refs: [0],
                },
            ],
        };
    }
    const inputBuffers = splat.table.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    const { blockBoxes, gaussianCount, data } = getModule().split_splat(
        inputBuffers,
        splat.shCounts,
        blockPrecision,
        splitNormal,
        defaultThreadPool(),
    );
    const blocks: BlockedSplats[] = [];
    const splats: SplatData[] = [];
    const blockView = new Float32Array(blockBoxes.buffer, blockBoxes.byteOffset, blockBoxes.byteLength / 4);
    const gaussianCountView = new Uint32Array(
        gaussianCount.buffer,
        gaussianCount.byteOffset,
        gaussianCount.byteLength / 4,
    );
    const blockCount = blockView.length / 6;

    // read splats
    {
        for (let i = 0; i < gaussianCountView.length; i++) {
            const count = gaussianCountView[i];
            const splatData = new SplatData(1, splat.shDegree);
            splatData.shDegree = splat.shDegree;
            splatData.shCounts = splat.shCounts;
            splatData.counts = count;
            splatData.table = data.slice(i * splat.table.length, i * splat.table.length + splat.table.length);
            splats.push(splatData);
        }
    }

    for (let i = 0; i < blockCount; i++) {
        const block: BlockedSplats = {
            box: {
                min: [blockView[i * 6], blockView[i * 6 + 1], blockView[i * 6 + 2]],
                max: [blockView[i * 6 + 3], blockView[i * 6 + 4], blockView[i * 6 + 5]],
            },
            refs: [i],
        };
        blocks.push(block);
    }

    return {
        splats,
        blocks,
    };
}

export class WebPLosslessProfile {
    readonly lossless = true;
}

export class WebPQualityProfile {
    readonly lossless = false;
    constructor(readonly quality: number) {}
}

export function encodeWebP(
    data: Uint8Array | Buffer,
    width: number,
    height: number,
    profile: WebPLosslessProfile | WebPQualityProfile,
) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (profile.lossless) {
        return getModule().webp_encode_rgba_lossless(buffer, width, height);
    } else {
        return getModule().webp_encode_rgba(buffer, width, height, profile.quality);
    }
}

export function decodeWebP(data: Uint8Array | Buffer) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().webp_decode_rgba(buffer);
}

export function encodeAVIF(data: Uint8Array | Buffer, width: number, height: number, quality: number) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().avif_encode_rgba(buffer, width, height, quality);
}

export interface AVIFEncodeInput {
    data: Uint8Array | Buffer;
    width: number;
    height: number;
    quality: number;
}

export function encodeAVIFBatched(inputs: AVIFEncodeInput[]) {
    return getModule().avif_encode_rgba_batched(
        inputs.map(i => ({
            ...i,
            data: i.data instanceof Buffer ? i.data : Buffer.from(i.data.buffer, i.data.byteOffset, i.data.byteLength),
        })),
        smallThreadPool(),
    );
}

export function decodeAVIF(data: Uint8Array | Buffer) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().avif_decode_rgba(buffer);
}

export function decodeAVIFBatched(inputs: Array<Uint8Array | Buffer>) {
    return getModule().avif_decode_rgba_batched(
        inputs.map(i => (i instanceof Buffer ? i : Buffer.from(i.buffer, i.byteOffset, i.byteLength))),
        smallThreadPool(),
    );
}

export function clusterAverage(dataTable: Float32Array[], labels: Uint32Array, k: number, output: Float32Array[]) {
    return getModule().cluster_average(
        dataTable.map(t => Buffer.from(t.buffer, t.byteOffset, t.byteLength)),
        Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength),
        k,
        output.map(t => Buffer.from(t.buffer, t.byteOffset, t.byteLength)),
        defaultThreadPool(),
    );
}
