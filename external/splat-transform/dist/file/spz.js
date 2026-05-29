import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { SH_C0, SH_MAPS } from '../constant.js';
import { BufferReader, fromHalf, clamp, StreamChunkDecoder, mortonSort } from '../utils/index.js';
const SPZ_MAGIC = 0x5053474e; // NGSP = Niantic gaussian splat
const SPZ_VERSION = 3;
const ZSTD_COMPRESSION_LEVEL = 12;
const FLAG_ANTIALIASED = 0x1;
const COLOR_SCALE = SH_C0 / 0.15;
const rotation = new Array(4);
const SH_SCALE1 = 1 << 3;
const SH_SCALE2 = 1 << 4;
export class SpzFile {
    constructor(compressLevel, spzVersion = SPZ_VERSION) {
        if (spzVersion !== 3 && spzVersion !== 4) {
            throw new Error(`Unsupported SPZ version: ${spzVersion}`);
        }
        this.compressLevel = compressLevel;
        this.spzVersion = spzVersion;
    }
    async read(stream, _contentLength, data) {
        const setCenter = data.setCenter.bind(data);
        const setAlpha = data.setAlpha.bind(data);
        const setColor = data.setColor.bind(data);
        const setScale = data.setScale.bind(data);
        const setQuat = data.setQuat.bind(data);
        const setShN = data.setShN.bind(data);
        const SCALE_LUT = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            SCALE_LUT[i] = Math.exp(i / 16 - 10);
        }
        const COLOR_LUT = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            COLOR_LUT[i] = (i / 255 - 0.5) * COLOR_SCALE + 0.5;
        }
        let version = SPZ_VERSION;
        let counts = 0;
        let shDegree = 0;
        let fractionalBits = 12;
        let flags = FLAG_ANTIALIASED;
        let reserved = 0;
        let isF16 = false;
        let useSmallestThreeQuat = true;
        let fraction = 1;
        let fractionInv = 1;
        let shCounts = 0;
        let BlockOffset = 0;
        const shN = [];
        const reader = new BufferReader();
        const decoder = new StreamChunkDecoder(reader);
        decoder.setDecoders([
            {
                init: () => [1, 16],
                decode: async (_offset, _counts, buf) => {
                    const header = new DataView(buf.buffer);
                    if (header.getUint32(0, true) !== SPZ_MAGIC) {
                        throw new Error('Invalid SPZ file');
                    }
                    ({ version, counts, shDegree, fractionalBits, flags, extra: reserved } = readSpzHeader(header));
                    if (version < 1 || version > 3) {
                        throw new Error(`Unsupported SPZ version: ${version}`);
                    }
                    isF16 = version < 2;
                    useSmallestThreeQuat = version >= 3;
                    fraction = 1 << fractionalBits;
                    fractionInv = 1 / fraction;
                    shCounts = SH_MAPS[shDegree];
                    BlockOffset = await data.initBlock(counts, shDegree);
                    if (flags || reserved) {
                        //
                    }
                },
            },
            {
                init: () => [counts, isF16 ? 6 : 9],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    let x, y, z;
                    for (let i = 0; i < counts; i++) {
                        if (isF16) {
                            const o = i * 6;
                            x = fromHalf((buf[o + 1] << 8) | buf[o]);
                            y = fromHalf((buf[o + 3] << 8) | buf[o + 2]);
                            z = fromHalf((buf[o + 5] << 8) | buf[o + 4]);
                        }
                        else {
                            const o = i * 9;
                            x = (((buf[o + 2] << 24) | (buf[o + 1] << 16) | (buf[o] << 8)) >> 8) * fractionInv;
                            y = (((buf[o + 5] << 24) | (buf[o + 4] << 16) | (buf[o + 3] << 8)) >> 8) * fractionInv;
                            z = (((buf[o + 8] << 24) | (buf[o + 7] << 16) | (buf[o + 6] << 8)) >> 8) * fractionInv;
                        }
                        setCenter(offset + i, x, y, z);
                    }
                },
            },
            {
                init: () => [counts, 1],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    for (let i = 0; i < counts; i++) {
                        setAlpha(offset + i, buf[i] / 255);
                    }
                },
            },
            {
                init: () => [counts, 3],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    for (let i = 0; i < counts; i++) {
                        const o = i * 3;
                        setColor(offset + i, COLOR_LUT[buf[o]], COLOR_LUT[buf[o + 1]], COLOR_LUT[buf[o + 2]]);
                    }
                },
            },
            {
                init: () => [counts, 3],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    for (let i = 0; i < counts; i++) {
                        const o = i * 3;
                        setScale(offset + i, SCALE_LUT[buf[o]], SCALE_LUT[buf[o + 1]], SCALE_LUT[buf[o + 2]]);
                    }
                },
            },
            {
                init: () => [counts, useSmallestThreeQuat ? 4 : 3],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    let qx, qy, qz, qw;
                    for (let i = 0; i < counts; i++) {
                        if (!useSmallestThreeQuat) {
                            const o = i * 3;
                            qx = buf[o] / 127.5 - 1;
                            qy = buf[o + 1] / 127.5 - 1;
                            qz = buf[o + 2] / 127.5 - 1;
                            qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
                        }
                        else {
                            const o = i * 4;
                            const packed = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
                            const largest = packed >>> 30;
                            let temp = packed;
                            let sum = 0;
                            for (let j = 3; j >= 0; j--) {
                                if (j === largest) {
                                    continue;
                                }
                                const mag = temp & 0x1FF;
                                const sign = (temp >>> 9) & 1;
                                temp >>>= 10;
                                const v = Math.SQRT1_2 * (mag / 0x1FF) * (sign ? -1 : 1);
                                rotation[j] = v;
                                sum += v * v;
                            }
                            rotation[largest] = Math.sqrt(1 - sum);
                            qx = rotation[0];
                            qy = rotation[1];
                            qz = rotation[2];
                            qw = rotation[3];
                        }
                        setQuat(offset + i, qx, qy, qz, qw);
                    }
                },
            },
            {
                init: () => [counts, shCounts],
                decode: (offset, counts, buf) => {
                    offset += BlockOffset;
                    for (let i = 0; i < counts; i++) {
                        const o = i * shCounts;
                        for (let j = 0; j < shCounts; j++) {
                            shN[j] = (buf[o + j] - 128) / 128;
                        }
                        setShN(offset + i, shN);
                    }
                },
            },
        ]);
        const peeked = await peekStream(stream, 8);
        stream = peeked.stream;
        if (isSpzV4(peeked.prefix)) {
            await readSpzV4Stream(stream, reader, decoder);
            data.finishBlock();
            return;
        }
        let source;
        if (this.compressLevel === -1) {
            source = stream.getReader();
        }
        else {
            source = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
        }
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
    async write(writeStream, data, indices = mortonSort(data)) {
        if (this.spzVersion === 4) {
            await this.writeV4(writeStream, data, indices);
        }
        else {
            await this.writeV3(writeStream, data, indices);
        }
    }
    async writeV3(writeStream, data, indices) {
        let writer;
        let pipePromise;
        if (this.compressLevel === -1) {
            writer = writeStream.getWriter();
            pipePromise = Promise.resolve();
        }
        else {
            const compressStream = new CompressionStream('gzip');
            pipePromise = compressStream.readable.pipeTo(writeStream);
            writer = compressStream.writable.getWriter();
        }
        const version = SPZ_VERSION;
        const counts = data.counts;
        const shDegree = data.shDegree;
        const fractionalBits = 12;
        const flags = FLAG_ANTIALIASED;
        const shCounts = getShCounts(shDegree);
        const context = createSpzEncodeContext(data, indices, fractionalBits, shCounts);
        // header
        writer.write(createSpzHeader(version, counts, shDegree, fractionalBits, flags, 0));
        for (const attribute of getSpzAttributes(shDegree)) {
            await writeSpzAttribute(writer, context, attribute);
        }
        await writer.close();
        await pipePromise;
    }
    async writeV4(writeStream, data, indices) {
        const version = 4;
        const counts = data.counts;
        const shDegree = data.shDegree;
        const fractionalBits = 12;
        const flags = FLAG_ANTIALIASED;
        const shCounts = getShCounts(shDegree);
        const context = createSpzEncodeContext(data, indices, fractionalBits, shCounts);
        const compressed = [];
        const uncompressedSizes = [];
        for (const attribute of getSpzAttributes(shDegree)) {
            const chunk = createSpzAttributeChunk(context, attribute, 0, counts);
            uncompressedSizes.push(chunk.byteLength);
            compressed.push(zstdCompressSync(chunk, {
                params: {
                    [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL,
                },
            }));
        }
        const tocByteOffset = 32;
        const tocSize = compressed.length * 16;
        const header = createSpzHeader(version, counts, shDegree, fractionalBits, flags, compressed.length, 32);
        new DataView(header.buffer).setUint32(16, tocByteOffset, true);
        const toc = new Uint8Array(tocSize);
        const tocView = new DataView(toc.buffer);
        for (let i = 0; i < compressed.length; i++) {
            const entryOffset = i * 16;
            writeUint64(tocView, entryOffset, compressed[i].byteLength);
            writeUint64(tocView, entryOffset + 8, uncompressedSizes[i]);
        }
        const writer = writeStream.getWriter();
        await writer.write(header);
        await writer.write(toc);
        for (const chunk of compressed) {
            await writer.write(chunk);
        }
        await writer.close();
    }
}
function getShCounts(shDegree) {
    const shCounts = SH_MAPS[shDegree];
    if (shCounts === undefined) {
        throw new Error(`Unsupported SPZ SH degree: ${shDegree}`);
    }
    return shCounts;
}
function createSpzEncodeContext(data, indices, fractionalBits, shCounts) {
    return {
        data,
        indices,
        fractionalBits,
        fraction: 1 << fractionalBits,
        shCounts,
        single: {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: new Array(shCounts),
        },
    };
}
function getSpzAttributes(shDegree) {
    return shDegree > 0 ? ['position', 'alpha', 'color', 'scale', 'quat', 'sh'] : ['position', 'alpha', 'color', 'scale', 'quat'];
}
function getSpzAttributeInfo(attribute, shCounts) {
    switch (attribute) {
        case 'position':
            return { itemSize: 9, chunkSize: 4096 };
        case 'alpha':
            return { itemSize: 1, chunkSize: 65536 };
        case 'color':
        case 'scale':
            return { itemSize: 3, chunkSize: 16384 };
        case 'quat':
            return { itemSize: 4, chunkSize: 16384 };
        case 'sh':
            return { itemSize: shCounts, chunkSize: 1024 };
    }
}
function createSpzAttributeChunk(context, attribute, offset, counts) {
    const { data, indices, single, shCounts } = context;
    const { itemSize } = getSpzAttributeInfo(attribute, shCounts);
    const chunk = new Uint8Array(counts * itemSize);
    for (let i = 0; i < counts; i++) {
        const index = indices[offset + i];
        switch (attribute) {
            case 'position': {
                data.getCenter(index, single);
                const o = i * itemSize;
                const ix = clamp(single.x * context.fraction, -0x7fffff, 0x7fffff);
                chunk[o + 0] = ix & 0xff;
                chunk[o + 1] = (ix >> 8) & 0xff;
                chunk[o + 2] = (ix >> 16) & 0xff;
                const iy = clamp(single.y * context.fraction, -0x7fffff, 0x7fffff);
                chunk[o + 3] = iy & 0xff;
                chunk[o + 4] = (iy >> 8) & 0xff;
                chunk[o + 5] = (iy >> 16) & 0xff;
                const iz = clamp(single.z * context.fraction, -0x7fffff, 0x7fffff);
                chunk[o + 6] = iz & 0xff;
                chunk[o + 7] = (iz >> 8) & 0xff;
                chunk[o + 8] = (iz >> 16) & 0xff;
                break;
            }
            case 'alpha':
                data.getAlpha(index, single);
                chunk[i] = clamp(Math.round(single.a * 255), 0, 255);
                break;
            case 'color': {
                data.getColor(index, single);
                const o = i * itemSize;
                chunk[o + 0] = clamp(Math.round(((single.r - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 1] = clamp(Math.round(((single.g - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 2] = clamp(Math.round(((single.b - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                break;
            }
            case 'scale': {
                data.getScale(index, single);
                const o = i * itemSize;
                chunk[o + 0] = clamp(Math.round((Math.log(single.sx) + 10) * 16), 0, 255);
                chunk[o + 1] = clamp(Math.round((Math.log(single.sy) + 10) * 16), 0, 255);
                chunk[o + 2] = clamp(Math.round((Math.log(single.sz) + 10) * 16), 0, 255);
                break;
            }
            case 'quat': {
                data.getQuat(index, single);
                const o = i * itemSize;
                rotation[0] = single.qx;
                rotation[1] = single.qy;
                rotation[2] = single.qz;
                rotation[3] = single.qw;
                let iLargest = 0;
                for (let j = 1; j < 4; ++j) {
                    if (Math.abs(rotation[j]) > Math.abs(rotation[iLargest])) {
                        iLargest = j;
                    }
                }
                const negate = rotation[iLargest] < 0 ? 1 : 0;
                let comp = iLargest;
                for (let j = 0; j < 4; ++j) {
                    if (j !== iLargest) {
                        const negbit = (rotation[j] < 0 ? 1 : 0) ^ negate;
                        const mag = Math.floor(((1 << 9) - 1) * (Math.abs(rotation[j]) / Math.SQRT1_2) + 0.5);
                        comp = (comp << 10) | (negbit << 9) | mag;
                    }
                }
                chunk[o + 0] = comp & 0xff;
                chunk[o + 1] = (comp >> 8) & 0xff;
                chunk[o + 2] = (comp >> 16) & 0xff;
                chunk[o + 3] = (comp >> 24) & 0xff;
                break;
            }
            case 'sh': {
                data.getShN(index, single.shN);
                const o = i * itemSize;
                for (let j = 0; j < itemSize; j++) {
                    if (j < 9) {
                        chunk[o + j] = clamp(Math.floor((Math.round(single.shN[j] * 128) + 128 + SH_SCALE1 / 2) / SH_SCALE1) * SH_SCALE1, 0, 255);
                        continue;
                    }
                    chunk[o + j] = clamp(Math.floor((Math.round(single.shN[j] * 128) + 128 + SH_SCALE2 / 2) / SH_SCALE2) * SH_SCALE2, 0, 255);
                }
                break;
            }
        }
    }
    return chunk;
}
async function writeSpzAttribute(writer, context, attribute) {
    const { chunkSize } = getSpzAttributeInfo(attribute, context.shCounts);
    const chunkCounts = Math.ceil(context.data.counts / chunkSize);
    for (let i = 0; i < chunkCounts; i++) {
        if (writer.desiredSize <= 0) {
            await writer.ready;
        }
        const offset = i * chunkSize;
        const counts = Math.min(chunkSize, context.data.counts - offset);
        writer.write(createSpzAttributeChunk(context, attribute, offset, counts));
    }
}
function readUint64(view, offset) {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) {
        throw new Error(`SPZ stream size is too large: ${value}`);
    }
    return value;
}
function writeUint64(view, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid SPZ stream size: ${value}`);
    }
    view.setUint32(offset, value >>> 0, true);
    view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}
function createSpzHeader(version, counts, shDegree, fractionalBits, flags, extra, byteLength = 16) {
    const header = new DataView(new ArrayBuffer(byteLength));
    header.setUint32(0, SPZ_MAGIC, true);
    header.setUint32(4, version, true);
    header.setUint32(8, counts, true);
    header.setUint8(12, shDegree);
    header.setUint8(13, fractionalBits);
    header.setUint8(14, flags);
    header.setUint8(15, extra);
    return new Uint8Array(header.buffer);
}
function readSpzHeader(view) {
    return {
        version: view.getUint32(4, true),
        counts: view.getUint32(8, true),
        shDegree: view.getUint8(12),
        fractionalBits: view.getUint8(13),
        flags: view.getUint8(14),
        extra: view.getUint8(15),
    };
}
function getSpzV4AttributeSizes(counts, shDegree) {
    const shCounts = getShCounts(shDegree);
    const sizes = [
        counts * 9, // position
        counts, // alpha
        counts * 3, // color
        counts * 3, // scale
        counts * 4, // quat
    ];
    if (shDegree > 0) {
        sizes.push(counts * shCounts); // sh
    }
    return sizes;
}
function isSpzV4(buffer) {
    if (buffer.byteLength < 8) {
        return false;
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return view.getUint32(0, true) === SPZ_MAGIC && view.getUint32(4, true) === 4;
}
async function readSpzV4Stream(stream, reader, decoder) {
    const read = createExactReader(stream);
    const header = await read(32);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const { counts, shDegree, fractionalBits, flags, extra: numStreams } = readSpzHeader(view);
    const tocByteOffset = view.getUint32(16, true);
    const expectedSizes = getSpzV4AttributeSizes(counts, shDegree);
    if (numStreams !== expectedSizes.length) {
        throw new Error(`Invalid SPZ v4 stream count: ${numStreams}`);
    }
    if (tocByteOffset < 32) {
        throw new Error(`Invalid SPZ v4 TOC offset: ${tocByteOffset}`);
    }
    if (tocByteOffset > 32) {
        await read(tocByteOffset - 32);
    }
    const toc = await read(numStreams * 16);
    const tocView = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
    // Reuse the legacy v3 attribute decoder after parsing the v4 container.
    reader.write(createSpzHeader(SPZ_VERSION, counts, shDegree, fractionalBits, flags & FLAG_ANTIALIASED, 0));
    decoder.flush();
    for (let i = 0; i < numStreams; i++) {
        const entryOffset = i * 16;
        const compressedSize = readUint64(tocView, entryOffset);
        const uncompressedSize = readUint64(tocView, entryOffset + 8);
        if (uncompressedSize !== expectedSizes[i]) {
            throw new Error(`Invalid SPZ v4 stream size at index ${i}`);
        }
        const compressed = await read(compressedSize);
        const decompressed = zstdDecompressSync(compressed, {
            maxOutputLength: uncompressedSize,
        });
        if (decompressed.byteLength !== uncompressedSize) {
            throw new Error(`Invalid SPZ v4 decompressed size at index ${i}`);
        }
        reader.write(new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength));
        decoder.flush();
    }
}
// Return a reader that resolves exactly byteLength bytes and keeps leftover bytes for the next read.
function createExactReader(stream) {
    const reader = stream.getReader();
    let chunk;
    let chunkOffset = 0;
    return async (byteLength) => {
        const result = new Uint8Array(byteLength);
        let offset = 0;
        while (offset < byteLength) {
            if (!chunk || chunkOffset >= chunk.byteLength) {
                const { done, value } = await reader.read();
                if (done || !value) {
                    throw new Error('Invalid SPZ v4 file: stream ended unexpectedly');
                }
                chunk = value;
                chunkOffset = 0;
            }
            const copyLength = Math.min(byteLength - offset, chunk.byteLength - chunkOffset);
            result.set(chunk.subarray(chunkOffset, chunkOffset + copyLength), offset);
            chunkOffset += copyLength;
            offset += copyLength;
        }
        return result;
    };
}
// Peek leading bytes for format detection, then replay the consumed chunks through a replacement stream.
async function peekStream(stream, byteLength) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    while (size < byteLength) {
        const { done, value } = await reader.read();
        if (done || !value) {
            break;
        }
        chunks.push(value);
        size += value.byteLength;
    }
    const prefix = new Uint8Array(Math.min(size, byteLength));
    let offset = 0;
    for (const chunk of chunks) {
        const copyLength = Math.min(chunk.byteLength, prefix.byteLength - offset);
        prefix.set(chunk.subarray(0, copyLength), offset);
        offset += copyLength;
        if (offset === prefix.byteLength) {
            break;
        }
    }
    return {
        prefix,
        stream: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
            },
            async pull(controller) {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        }),
    };
}
