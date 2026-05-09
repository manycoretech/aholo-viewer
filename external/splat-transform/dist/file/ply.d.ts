import { SplatData } from '../SplatData.js';
import { IFile } from './IFile.js';
export declare class PlyFile implements IFile {
    private littleEndian;
    private comments;
    private elements;
    private isSuperSplatCompressed;
    private counts;
    private shDegree;
    private initHeader;
    read(stream: ReadableStream<Uint8Array>, _contentLength: number, data: SplatData): Promise<void>;
    write(stream: WritableStream<Uint8Array>, data: SplatData, indices?: Uint32Array): Promise<void>;
}
