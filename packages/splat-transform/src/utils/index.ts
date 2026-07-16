export function sleep(timeout: number) {
    return new Promise<void>(resolve => {
        setTimeout(resolve, timeout);
    });
}

export function isUrl(str: string): boolean {
    let url: URL;
    try {
        url = new URL(str);
    } catch {
        return false;
    }

    return url.protocol === 'http:' || url.protocol === 'https:';
}

export function extractFromRootDir(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
    let dir: string = '';
    for (const path in entries) {
        if (path.endsWith('/')) {
            dir = path;
            break;
        }
    }
    const result: Record<string, Uint8Array> = {};
    for (const path in entries) {
        result[path.replace(dir, '')] = entries[path];
    }
    return result;
}

export * from './Logger.js';
export * from './StreamChunkDecoder.js';
export * from './ByteStreamCursor.js';
export * from './math.js';
export * from './encoding.js';
export * from './shRotate.js';
export * from './splat.js';
export * from './k-means/index.js';
export * from './quantize1d.js';
export * from './worker.js';
export * from './webgpu.js';
export * from './voxel/common.js';
export * from './voxel/voxelize.js';
export * from './voxel/postprocess.js';
export * from './voxel/nav.js';
export * from './voxel/mesh.js';
export * from './voxel/voxelFaces.js';
export * from './voxel/gpuDilation.js';
export * from './deferred.js';
export * from './stream.js';
