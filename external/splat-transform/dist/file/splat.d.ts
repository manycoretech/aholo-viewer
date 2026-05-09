import { SplatData } from '../SplatData.js';
import { IFile } from './IFile.js';
export declare class SplatFile implements IFile {
    read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData): Promise<void>;
    write(stream: WritableStream<Uint8Array>, data: SplatData, indices?: Uint32Array): Promise<void>;
}
