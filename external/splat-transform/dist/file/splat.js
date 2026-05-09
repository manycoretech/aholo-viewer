import { clamp, StreamChunkDecoder, BufferReader, mortonSort } from '../utils/index.js';
const ItemSize = 32;
export class SplatFile {
    async read(stream, contentLength, data) {
        const setFn = data.set.bind(data);
        const counts = Math.floor(contentLength / ItemSize);
        const BlockOffset = await data.initBlock(counts, 0);
        const reader = new BufferReader();
        const decoder = new StreamChunkDecoder(reader);
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        decoder.setDecoders([
            {
                init: () => [counts, ItemSize],
                decode: (offset, counts, buffer) => {
                    offset += BlockOffset;
                    const f32Array = new Float32Array(buffer.buffer);
                    let o = 0;
                    for (let i = 0; i < counts; i++) {
                        o = i * 8;
                        single.x = f32Array[o];
                        single.y = f32Array[o + 1];
                        single.z = f32Array[o + 2];
                        single.sx = f32Array[o + 3];
                        single.sy = f32Array[o + 4];
                        single.sz = f32Array[o + 5];
                        o = i * 32;
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
        const source = stream.getReader();
        while (true) {
            const { done, value } = await source.read();
            if (done) {
                break;
            }
            reader.write(value);
            decoder.flush();
        }
        data.finishBlock();
    }
    async write(stream, data, indices = mortonSort(data)) {
        const writer = stream.getWriter();
        const chunkSize = 2048;
        const chunkCounts = Math.ceil(data.counts / chunkSize);
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        for (let i = 0; i < chunkCounts; i++) {
            if (writer.desiredSize <= 0) {
                await writer.ready;
            }
            const currentChunkSize = Math.min(chunkSize, data.counts - i * chunkSize);
            const chunk = new Uint8Array(currentChunkSize * ItemSize);
            const dataView = new DataView(chunk.buffer);
            const offset = i * chunkSize;
            for (let j = 0; j < currentChunkSize; j++) {
                data.get(indices[offset + j], single);
                const o = j * ItemSize;
                dataView.setFloat32(o, single.x, true);
                dataView.setFloat32(o + 4, single.y, true);
                dataView.setFloat32(o + 8, single.z, true);
                dataView.setFloat32(o + 12, single.sx, true);
                dataView.setFloat32(o + 16, single.sy, true);
                dataView.setFloat32(o + 20, single.sz, true);
                dataView.setUint8(o + 24, clamp(Math.round(single.r * 255), 0, 255));
                dataView.setUint8(o + 25, clamp(Math.round(single.g * 255), 0, 255));
                dataView.setUint8(o + 26, clamp(Math.round(single.b * 255), 0, 255));
                dataView.setUint8(o + 27, clamp(Math.round(single.a * 255), 0, 255));
                dataView.setUint8(o + 28, clamp(Math.round(single.qw * 128 + 128), 0, 255));
                dataView.setUint8(o + 29, clamp(Math.round(single.qx * 128 + 128), 0, 255));
                dataView.setUint8(o + 30, clamp(Math.round(single.qy * 128 + 128), 0, 255));
                dataView.setUint8(o + 31, clamp(Math.round(single.qz * 128 + 128), 0, 255));
            }
            writer.write(chunk);
            await Promise.resolve();
        }
        await writer.close();
    }
}
