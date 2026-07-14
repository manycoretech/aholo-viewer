import type { ByteStreamCursor } from './ByteStreamCursor.js';

export interface ChunkDecoder {
    init(): Promise<[number, number]> | [number, number]; // [totals, itemSize]
    decode(offset: number, counts: number, buffer: Uint8Array): void;
}

export class StreamChunkDecoder {
    constructor(private cursor: ByteStreamCursor) {}

    async decode(decoders: ChunkDecoder[]) {
        for (const decoder of decoders) {
            const [totals, itemSize] = await decoder.init();
            if (totals === 0 || itemSize === 0) {
                continue;
            }

            const pending = new Uint8Array(itemSize);
            let pendingByteLength = 0;
            let decoded = 0;
            await this.cursor.readChunks(totals * itemSize, chunk => {
                let chunkOffset = 0;
                if (pendingByteLength > 0) {
                    const copyLength = Math.min(itemSize - pendingByteLength, chunk.byteLength);
                    pending.set(chunk.subarray(0, copyLength), pendingByteLength);
                    pendingByteLength += copyLength;
                    chunkOffset += copyLength;
                    if (pendingByteLength === itemSize) {
                        decoder.decode(decoded, 1, pending);
                        decoded++;
                        pendingByteLength = 0;
                    }
                }

                const counts = Math.floor((chunk.byteLength - chunkOffset) / itemSize);
                if (counts > 0) {
                    const batchByteLength = counts * itemSize;
                    decoder.decode(decoded, counts, chunk.subarray(chunkOffset, chunkOffset + batchByteLength));
                    decoded += counts;
                    chunkOffset += batchByteLength;
                }

                if (chunkOffset < chunk.byteLength) {
                    const remainder = chunk.subarray(chunkOffset);
                    pending.set(remainder);
                    pendingByteLength = remainder.byteLength;
                }
            });

            if (pendingByteLength !== 0 || decoded !== totals) {
                throw new Error(`Invalid stream data: expected ${totals} items, got ${decoded}`);
            }
        }
    }
}
