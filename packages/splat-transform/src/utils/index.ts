export interface Deferred<T = void> {
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason: any) => void;
    promise: Promise<T>;
}

export function deferred<T = void>(): Deferred<T> {
    let resolve: (value: T | PromiseLike<T>) => void = () => {};
    let reject: (reason: any) => void = () => {};
    const promise = new Promise<T>(function (resolveInner, rejectInner) {
        resolve = resolveInner;
        reject = rejectInner;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

export function sleep(timeout: number) {
    return new Promise<void>(resolve => {
        setTimeout(resolve, timeout);
    });
}

export function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
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

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
export function fromHalf(h: number): number {
    const sign = (h >> 15) & 0x1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;

    let f32bits: number;
    if (exp === 0) {
        if (frac === 0) {
            f32bits = sign << 31;
        } else {
            let mant = frac;
            let e = -14;
            while ((mant & 0x400) === 0) {
                mant <<= 1;
                e--;
            }
            mant &= 0x3ff;
            const newExp = e + 127;
            const newFrac = mant << 13;
            f32bits = (sign << 31) | (newExp << 23) | newFrac;
        }
    } else if (exp === 0x1f) {
        if (frac === 0) {
            f32bits = (sign << 31) | 0x7f800000;
        } else {
            f32bits = (sign << 31) | 0x7fc00000;
        }
    } else {
        const newExp = exp - 15 + 127;
        const newFrac = frac << 13;
        f32bits = (sign << 31) | (newExp << 23) | newFrac;
    }

    u32buffer[0] = f32bits;
    return f32buffer[0];
}

export * from './Logger.js';
export * from './BufferReader.js';
export * from './StreamChunkDecoder.js';
export * from './math.js';
export * from './sh-rotate.js';
export * from './splat.js';
export * from './k-means/index.js';
export * from './quantize-1d.js';
export * from './worker.js';
export * from './webgpu.js';
export * from './voxel/common.js';
export * from './voxel/voxelize.js';
export * from './voxel/postprocess.js';
export * from './voxel/nav.js';
export * from './voxel/mesh.js';
export * from './voxel/voxel-faces.js';
export * from './voxel/gpu-dilation.js';
