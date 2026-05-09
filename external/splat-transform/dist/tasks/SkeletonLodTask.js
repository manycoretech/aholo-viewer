import { SplatData } from '../SplatData.js';
import { BaseTask } from './BaseTask.js';
const VOXEL_CHUNK_SIZE = 0.02;
const VOXEL_CHUNK_SCALE = 1.3;
export class SkeletonLodTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { input, output, counts = 85000, ratio = 0.1 } = config;
        const splat = resources.get(input);
        logger.info(`loaded -> "${input}"`);
        const target = Math.min(Math.ceil(splat.counts * ratio), counts);
        logger.info(`expected -> ${target}(${((target / splat.counts) * 100).toFixed(2)}%) | ratio=${ratio} counts=${counts}`);
        const xCol = splat.table[0 /* ColIdx.x */];
        const yCol = splat.table[1 /* ColIdx.y */];
        const zCol = splat.table[2 /* ColIdx.z */];
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        for (let i = 0; i < splat.counts; i++) {
            const x = xCol[i];
            const y = yCol[i];
            const z = zCol[i];
            if (x < minX) {
                minX = x;
            }
            if (y < minY) {
                minY = y;
            }
            if (z < minZ) {
                minZ = z;
            }
        }
        const chunkMap = new Map();
        for (let i = 0; i < splat.counts; i++) {
            const x = ((xCol[i] - minX) / VOXEL_CHUNK_SIZE) | 0;
            const y = ((yCol[i] - minY) / VOXEL_CHUNK_SIZE) | 0;
            const z = ((zCol[i] - minZ) / VOXEL_CHUNK_SIZE) | 0;
            const key = `${x},${y},${z}`;
            let arr = chunkMap.get(key);
            if (!arr) {
                arr = [];
                chunkMap.set(key, arr);
            }
            arr.push(i);
        }
        const chunks = Array.from(chunkMap.values());
        const CHUNK_RATIO = chunks.reduce((p, c) => p + c.length ** VOXEL_CHUNK_SCALE, 0) / (target * 0.1);
        const mergeChucks = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const size = Math.max(1, Math.ceil((chunk.length ** VOXEL_CHUNK_SCALE) / CHUNK_RATIO));
            if (size === 1) {
                mergeChucks.push(chunk);
                continue;
            }
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (let j = 0; j < chunk.length; j++) {
                const offset = chunk[j];
                const x = xCol[offset];
                const y = yCol[offset];
                const z = zCol[offset];
                if (x < minX) {
                    minX = x;
                }
                if (y < minY) {
                    minY = y;
                }
                if (z < minZ) {
                    minZ = z;
                }
                if (x > maxX) {
                    maxX = x;
                }
                if (y > maxY) {
                    maxY = y;
                }
                if (z > maxZ) {
                    maxZ = z;
                }
            }
            const subChuckSize = Math.ceil(Math.cbrt(size));
            const scaleX = subChuckSize / Math.max(maxX - minX, 1e-9);
            const scaleY = subChuckSize / Math.max(maxY - minY, 1e-9);
            const scaleZ = subChuckSize / Math.max(maxZ - minZ, 1e-9);
            const subChunkMap = new Map();
            for (let j = 0; j < chunk.length; j++) {
                const idx = chunk[j];
                const x = ((xCol[idx] - minX) * scaleX) | 0;
                const y = ((yCol[idx] - minY) * scaleY) | 0;
                const z = ((zCol[idx] - minZ) * scaleZ) | 0;
                const key = `${x},${y},${z}`;
                let arr = subChunkMap.get(key);
                if (!arr) {
                    arr = [];
                    subChunkMap.set(key, arr);
                }
                arr.push(idx);
            }
            const subChunks = Array.from(subChunkMap.values());
            if (subChunks.length > size) {
                subChunks.sort((a, b) => b.length - a.length);
                subChunks.length = size;
            }
            for (let j = 0; j < subChunks.length; j++) {
                mergeChucks.push(subChunks[j]);
            }
        }
        if (mergeChucks.length > target) {
            mergeChucks.sort((a, b) => b.length - a.length);
            mergeChucks.length = target;
        }
        const raw = new SplatData().init(mergeChucks.length, 0);
        const result = {
            x: 0, y: 0, z: 0,
            sx: 0.005, sy: 0.005, sz: 0.005,
            qx: 0, qy: 0, qz: 0, qw: 1,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        for (let i = 0; i < mergeChucks.length; i++) {
            const chunk = mergeChucks[i];
            for (let j = 0; j < chunk.length; j++) {
                splat.get(chunk[j], single);
                result.x += single.x;
                result.y += single.y;
                result.z += single.z;
                result.r += single.r;
                result.g += single.g;
                result.b += single.b;
                result.a += single.a;
            }
            result.x /= chunk.length;
            result.y /= chunk.length;
            result.z /= chunk.length;
            result.r /= chunk.length;
            result.g /= chunk.length;
            result.b /= chunk.length;
            result.a /= chunk.length;
            raw.set(i, result);
            result.x = result.y = result.z = result.r = result.g = result.b = result.a = 0;
        }
        resources.set(output, raw);
        logger.info(`stored -> key="${output}"`);
    }
}
