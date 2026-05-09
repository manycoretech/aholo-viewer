import { SplatData } from '../SplatData.js';
import { Buffer } from 'node:buffer';
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
export declare function generateLod(splat: SplatData, levelParameters: LevelParameter[], blockPrecision: number, minSize: number, maxStep: number): BlockedResult;
export declare class WebPLosslessProfile {
    readonly lossless = true;
}
export declare class WebPQualityProfile {
    readonly quality: number;
    readonly lossless = false;
    constructor(quality: number);
}
export declare function encodeWebP(data: Uint8Array | Buffer, width: number, height: number, profile: WebPLosslessProfile | WebPQualityProfile): Buffer<ArrayBufferLike>;
export declare function decodeWebP(data: Uint8Array | Buffer): {
    data: Buffer;
    width: number;
    height: number;
};
export declare function encodeAVIF(data: Uint8Array | Buffer, width: number, height: number, quality: number): Buffer<ArrayBufferLike>;
export interface AVIFEncodeInput {
    data: Uint8Array | Buffer;
    width: number;
    height: number;
    quality: number;
}
export declare function encodeAVIFBatched(inputs: AVIFEncodeInput[]): Buffer<ArrayBufferLike>[];
export declare function decodeAVIF(data: Uint8Array | Buffer): {
    data: Buffer;
    width: number;
    height: number;
};
export declare function decodeAVIFBatched(inputs: Array<Uint8Array | Buffer>): {
    data: Buffer;
    width: number;
    height: number;
}[];
export declare function clusterAverage(dataTable: Float32Array[], clusters: Uint32Array[], output: Float32Array[]): void;
