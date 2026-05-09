import { SplatData } from '../SplatData.js';
import { IFile } from './IFile.js';
export declare class LccFile implements IFile {
    private counts;
    private shDegree;
    private meta;
    private refs;
    private load;
    read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData): Promise<void>;
    write(_stream: WritableStream<Uint8Array>, _data: SplatData): Promise<void>;
}
