import type { SplatData } from '../SplatData.js';
import { ByteStreamCursor, clamp, StreamChunkDecoder, createSingleSplat } from '../utils/index.js';
import type { IFile } from './IFile.js';

const ITEM_SIZE = 32;
const STREAM_CHUNK_BYTE_LENGTH = 128 * 1024;
const STREAM_CHUNK_ITEM_COUNTS = Math.floor(STREAM_CHUNK_BYTE_LENGTH / ITEM_SIZE);
export class SplatFile implements IFile {
    async read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData) {
        const setFn = data.set.bind(data) as SplatData['set'];
        const counts = Math.floor(contentLength / ITEM_SIZE);
        const BlockOffset = await data.initBlock(counts, 0);
        const single = createSingleSplat();

        const decoder = new StreamChunkDecoder(new ByteStreamCursor(stream));
        await decoder.decode([
            {
                init: () => [counts, ITEM_SIZE],
                decode: (offset, counts, buffer) => {
                    offset += BlockOffset;
                    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                    for (let i = 0; i < counts; i++) {
                        const o = i * ITEM_SIZE;
                        single.x = view.getFloat32(o, true);
                        single.y = view.getFloat32(o + 4, true);
                        single.z = view.getFloat32(o + 8, true);
                        single.sx = view.getFloat32(o + 12, true);
                        single.sy = view.getFloat32(o + 16, true);
                        single.sz = view.getFloat32(o + 20, true);
                        single.r = buffer[o + 24] / 255;
                        single.g = buffer[o + 25] / 255;
                        single.b = buffer[o + 26] / 255;
                        single.a = buffer[o + 27] / 255;
                        single.qw = (buffer[o + 28] - 128) / 128;
                        single.qx = (buffer[o + 29] - 128) / 128;
                        single.qy = (buffer[o + 30] - 128) / 128;
                        single.qz = (buffer[o + 31] - 128) / 128;
                        setFn(offset + i, single);
                    }
                },
            },
        ]);
        data.finishBlock();
    }

    async write(stream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        const writer = stream.getWriter();
        const single = createSingleSplat();
        for (let i = 0; i < data.counts; i += STREAM_CHUNK_ITEM_COUNTS) {
            const currentChunkSize = Math.min(STREAM_CHUNK_ITEM_COUNTS, data.counts - i);
            const chunk = new Uint8Array(currentChunkSize * ITEM_SIZE);
            const view = new DataView(chunk.buffer);
            for (let j = 0; j < currentChunkSize; j++) {
                data.get(indices[i + j], single);
                const o = j * ITEM_SIZE;
                view.setFloat32(o + 0, single.x, true);
                view.setFloat32(o + 4, single.y, true);
                view.setFloat32(o + 8, single.z, true);
                view.setFloat32(o + 12, single.sx, true);
                view.setFloat32(o + 16, single.sy, true);
                view.setFloat32(o + 20, single.sz, true);
                view.setUint8(o + 24, clamp(Math.round(single.r * 255), 0, 255));
                view.setUint8(o + 25, clamp(Math.round(single.g * 255), 0, 255));
                view.setUint8(o + 26, clamp(Math.round(single.b * 255), 0, 255));
                view.setUint8(o + 27, clamp(Math.round(single.a * 255), 0, 255));
                view.setUint8(o + 28, clamp(Math.round(single.qw * 128 + 128), 0, 255));
                view.setUint8(o + 29, clamp(Math.round(single.qx * 128 + 128), 0, 255));
                view.setUint8(o + 30, clamp(Math.round(single.qy * 128 + 128), 0, 255));
                view.setUint8(o + 31, clamp(Math.round(single.qz * 128 + 128), 0, 255));
            }
            writer.write(chunk);
            if (writer.desiredSize! <= 0) {
                await writer.ready;
            }
        }

        await writer.close();
    }
}
