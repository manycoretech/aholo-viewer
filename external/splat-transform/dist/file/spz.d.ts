import { SplatData } from '../SplatData.js';
import { IFile } from './IFile.js';
export declare class SpzFile implements IFile {
    readonly compressLevel: number;
    readonly spzVersion: number;
    constructor(compressLevel: number, spzVersion?: number);
    read(stream: ReadableStream<Uint8Array>, _contentLength: number, data: SplatData): Promise<void>;
    write(writeStream: WritableStream<Uint8Array>, data: SplatData, indices?: Uint32Array): Promise<void>;
    private writeV3;
    private writeV4;
}
