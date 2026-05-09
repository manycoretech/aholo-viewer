import * as child_process from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { SplatData } from '../SplatData.js';
import { Buffer } from 'node:buffer';
const getModule = (function () {
    let m = undefined;
    const require = createRequire(import.meta.url);
    const platform = os.platform();
    const binaryPath = `./cpp/bin/${platform === 'win32' ? 'windows' : platform}/binding.node`;
    return function () {
        if (!m) {
            try {
                m = require(binaryPath);
            }
            catch {
                console.warn(`cannot find a valid binary at: ${binaryPath}, try rebuild`);
                child_process.spawnSync('node', [
                    require.resolve('cmake-js/bin/cmake-js'),
                    'build',
                    '--',
                    '--preset',
                    'default'
                ], {
                    cwd: path.join(import.meta.dirname, 'cpp'),
                    stdio: 'inherit'
                });
                m = require(binaryPath);
            }
        }
        return m;
    };
})();
export function generateLod(splat, levelParameters, blockPrecision, minSize, maxStep) {
    if (splat.counts === 0) {
        return {
            splats: [splat],
            blocks: [{
                    box: { min: [0, 0, 0], max: [0, 0, 0] },
                    refs: new Array(levelParameters.length).fill(0),
                }],
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
    const { blockBoxes, blockRefs, gaussianCount, data, } = getModule().generate_lod(inputBuffers, splat.shCounts, buffer, blockPrecision, minSize, maxStep);
    const blockView = new Float32Array(blockBoxes.buffer, blockBoxes.byteOffset, blockBoxes.byteLength / 4);
    const blockRefsView = new Uint32Array(blockRefs.buffer, blockRefs.byteOffset, blockRefs.byteLength / 4);
    const blockCount = blockView.length / 6;
    const gaussianCountView = new Uint32Array(gaussianCount.buffer, gaussianCount.byteOffset, gaussianCount.byteLength / 4);
    const blocks = [];
    const splats = [];
    // read splats
    {
        let gaussianOffset = 0;
        for (const count of gaussianCountView) {
            const splatData = new SplatData(1, splat.shDegree);
            splatData.shDegree = splat.shDegree;
            splatData.shCounts = splat.shCounts;
            splatData.counts = count;
            splatData.table = data.map(buffer => new Float32Array(buffer.buffer, buffer.byteOffset + gaussianOffset * 4, count));
            splats.push(splatData);
            gaussianOffset += count;
        }
    }
    for (let i = 0; i < blockCount; i++) {
        const block = {
            box: {
                min: [blockView[i * 6], blockView[i * 6 + 1], blockView[i * 6 + 2]],
                max: [blockView[i * 6 + 3], blockView[i * 6 + 4], blockView[i * 6 + 5]]
            },
            refs: Array.from(blockRefsView.subarray(i * levels, i * levels + levels)),
        };
        blocks.push(block);
    }
    return { splats, blocks };
}
export class WebPLosslessProfile {
    lossless = true;
}
export class WebPQualityProfile {
    quality;
    lossless = false;
    constructor(quality) {
        this.quality = quality;
    }
    ;
}
export function encodeWebP(data, width, height, profile) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (profile.lossless) {
        return getModule().webp_encode_rgba_lossless(buffer, width, height);
    }
    else {
        return getModule().webp_encode_rgba(buffer, width, height, profile.quality);
    }
}
export function decodeWebP(data) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().webp_decode_rgba(buffer);
}
export function encodeAVIF(data, width, height, quality) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().avif_encode_rgba(buffer, width, height, quality);
}
export function encodeAVIFBatched(inputs) {
    return getModule().avif_encode_rgba_batched(inputs.map(i => ({ ...i, data: i.data instanceof Buffer ? i.data : Buffer.from(i.data.buffer, i.data.byteOffset, i.data.byteLength) })));
}
export function decodeAVIF(data) {
    const buffer = data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return getModule().avif_decode_rgba(buffer);
}
export function decodeAVIFBatched(inputs) {
    return getModule().avif_decode_rgba_batched(inputs.map(i => i instanceof Buffer ? i : Buffer.from(i.buffer, i.byteOffset, i.byteLength)));
}
export function clusterAverage(dataTable, clusters, output) {
    return getModule().cluster_average(dataTable.map(t => Buffer.from(t.buffer, t.byteOffset, t.byteLength)), clusters.map(t => Buffer.from(t.buffer, t.byteOffset, t.byteLength)), output.map(t => Buffer.from(t.buffer, t.byteOffset, t.byteLength)));
}
