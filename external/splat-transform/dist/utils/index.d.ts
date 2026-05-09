interface Deferred<T = void> {
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason: any) => void;
    promise: Promise<T>;
}
export declare function deferred<T = void>(): Deferred<T>;
export declare function sleep(timeout: number): Promise<void>;
export declare function clamp(v: number, min: number, max: number): number;
export declare function isUrl(str: string): boolean;
export declare function extractFromRootDir(entries: Record<string, Uint8Array>): Record<string, Uint8Array>;
export declare function fromHalf(h: number): number;
export * from './Logger.js';
export * from './BufferReader.js';
export * from './StreamChunkDecoder.js';
export * from './math.js';
export * from './sh-rotate.js';
export * from './splat.js';
export * from './k-means.js';
export * from './quantize-1d.js';
export * from './webgpu.js';
export * from './voxel/common.js';
export * from './voxel/voxelize.js';
export * from './voxel/postprocess.js';
export * from './voxel/nav.js';
export * from './voxel/mesh.js';
export * from './voxel/voxel-faces.js';
export * from './voxel/gpu-dilation.js';
