import { BlockMaskBuffer } from './common.js';
export declare const cpuVoxelize: (xCol: Float32Array, yCol: Float32Array, zCol: Float32Array, sxCol: Float32Array, syCol: Float32Array, szCol: Float32Array, qxCol: Float32Array, qyCol: Float32Array, qzCol: Float32Array, qwCol: Float32Array, aCol: Float32Array, extents: Float32Array, gridBounds: {
    min: {
        x: number;
        y: number;
        z: number;
    };
    max: {
        x: number;
        y: number;
        z: number;
    };
}, voxelResolution: number, opacityCutoff: number, options?: {
    workerCount?: number;
}) => Promise<BlockMaskBuffer>;
/**
 * GPU voxelization path using tiled multi-batch WGSL dispatch.
 * Per-batch Gaussian indices are built on the GPU (count pass, CPU prefix sum, fill pass) into `indexBuffer`,
 * replacing BVH `queryOverlappingRaw` on reference implementation. Batches are packed into mega-dispatches, then read back
 * as per-block 64-bit masks to populate `BlockMaskBuffer`.
 */
export declare const gpuVoxelize: (xCol: Float32Array, yCol: Float32Array, zCol: Float32Array, sxCol: Float32Array, syCol: Float32Array, szCol: Float32Array, qxCol: Float32Array, qyCol: Float32Array, qzCol: Float32Array, qwCol: Float32Array, aCol: Float32Array, extents: Float32Array, gridBounds: {
    min: {
        x: number;
        y: number;
        z: number;
    };
    max: {
        x: number;
        y: number;
        z: number;
    };
}, voxelResolution: number, opacityCutoff: number) => Promise<BlockMaskBuffer>;
