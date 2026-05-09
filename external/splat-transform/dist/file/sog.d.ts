import { SplatData } from '../SplatData.js';
import { IFile } from './IFile.js';
export interface SogMetadataV1 {
    version: undefined;
    means: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    scales: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    quats: {
        shape: number[];
        dtype: string;
        encoding?: string;
        files: string[];
    };
    sh0: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    shN?: {
        shape: number[];
        dtype: string;
        mins: number;
        maxs: number;
        quantization: number;
        files: string[];
    };
}
export interface SogMetadataV2 {
    version: number;
    count: number;
    means: {
        mins: number[];
        maxs: number[];
        files: string[];
    };
    scales: {
        codebook: number[];
        files: string[];
    };
    quats: {
        files: string[];
    };
    sh0: {
        codebook: number[];
        files: string[];
    };
    shN?: {
        count: number;
        bands: number;
        codebook: number[];
        files: string[];
    };
}
export type SogMetadata = SogMetadataV1 | SogMetadataV2;
export declare class SogFile implements IFile {
    readonly iterations: number;
    private counts;
    private shDegree;
    private cached;
    constructor(iterations?: number);
    load(stream: ReadableStream<Uint8Array>, contentLength: number): Promise<void>;
    private parse_v1;
    private parse_v2;
    private loadTexture;
    read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData): Promise<void>;
    write(stream: WritableStream<Uint8Array>, data: SplatData, indices?: Uint32Array): Promise<void>;
}
