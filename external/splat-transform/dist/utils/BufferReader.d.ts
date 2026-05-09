export declare class BufferReader {
    head: number;
    tail: number;
    buffer: Uint8Array;
    view: DataView;
    get remaining(): number;
    constructor(buffer?: Uint8Array);
    private grow;
    private compact;
    write(chunk: Uint8Array): void;
    read(counts: number): Uint8Array;
}
