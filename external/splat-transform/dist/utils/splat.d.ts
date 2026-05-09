import { IFile } from '../file/index.js';
import { SplatData } from '../SplatData.js';
export declare enum SplatFileType {
    PLY = 0,
    SPZ = 1,
    USPZ = 2,// not gzip spz
    SPLAT = 3,
    KSPLAT = 4,
    SOG = 5,
    LCC = 6
}
export declare function detectSplatFileType(filename: string, buffer?: Uint8Array): SplatFileType | undefined;
export declare function createSplatFile(path: string, buffer?: Uint8Array, compressLevel?: number): IFile;
export declare function combineSplatData(source: SplatData[]): SplatData;
export declare function computeDenseBox(data: SplatData, ratio?: number): {
    min: number[];
    max: number[];
};
export declare function mortonSort(splat: SplatData): Uint32Array;
export declare function fastDeleteSplat(splat: SplatData, indices: number[]): void;
