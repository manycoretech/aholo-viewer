import { SplatData } from '../SplatData.js';
export interface IFile {
    read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData): Promise<void>;
    write(stream: WritableStream<Uint8Array>, data: SplatData, indices?: Uint32Array): Promise<void>;
}
