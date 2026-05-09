import { BufferReader } from './BufferReader.js';
export interface ChunkDecoder {
    init(): [number, number];
    decode(offset: number, counts: number, buffer: Uint8Array): void;
}
export declare class StreamChunkDecoder {
    private reader;
    private decoders;
    private decodedTotals;
    private currentIndex;
    private currentTotals;
    private currentItemSize;
    constructor(reader: BufferReader);
    setDecoders(decoders: ChunkDecoder[]): void;
    flush(): void;
}
