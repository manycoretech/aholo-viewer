import { Duplex } from 'node:stream';
import { createGzip, createZstdDecompress, zstdCompressSync, constants as zlibConstant } from 'node:zlib';
import { ColIdx, type SplatData } from '../SplatData.js';
import { SH_C0, SH_MAPS } from '../constant.js';
import { ByteStreamCursor, clamp, StreamChunkDecoder, fromHalf } from '../utils/index.js';
import type { IFile } from './IFile.js';

const SPZ_MAGIC = 0x5053474e; // NGSP = Niantic gaussian splat
const SPZ_VERSION = 4;
const SPZ_LEGACY_VERSION = 3;
const SPZ_FRACTIONAL_BITS = 12;
const SPZ_FRACTIONAL = 1 << SPZ_FRACTIONAL_BITS;
const FLAG_ANTIALIASED = 0x1;
const MAX_SAFE_STREAM_SIZE = BigInt(Number.MAX_SAFE_INTEGER);
const STREAM_CHUNK_BYTE_LENGTH = 128 * 1024;
const SPZ_STREAM_HEADER_BYTE_LENGTH = 32;
const SPZ_TOC_ENTRY_BYTE_LENGTH = 16;

const COLOR_SCALE = SH_C0 / 0.15;
const rotation: number[] = new Array(4);
const SH_SCALE1 = 1 << 3;
const SH_SCALE2 = 1 << 4;
const SCALE_LUT = new Float32Array(256);
const COLOR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    SCALE_LUT[i] = Math.exp(i / 16 - 10);
    COLOR_LUT[i] = (i / 255 - 0.5) * COLOR_SCALE + 0.5;
}

async function decodeAttribute(
    cursor: ByteStreamCursor,
    data: SplatData,
    blockOffset: number,
    version: number,
    counts: number,
    shCounts: number,
    fractionalBits: number,
) {
    const isF16 = version < 2;
    const useSmallestThreeQuat = version >= 3;
    const fractionInv = 1 / (1 << fractionalBits);
    const setCenter = data.setCenter.bind(data) as SplatData['setCenter'];
    const setAlpha = data.setAlpha.bind(data) as SplatData['setAlpha'];
    const setColor = data.setColor.bind(data) as SplatData['setColor'];
    const setScale = data.setScale.bind(data) as SplatData['setScale'];
    const setQuat = data.setQuat.bind(data) as SplatData['setQuat'];
    const setShN = data.setShN.bind(data) as SplatData['setShN'];
    const shN: number[] = new Array(shCounts).fill(0);

    const decoder = new StreamChunkDecoder(cursor);
    await decoder.decode([
        {
            init: () => [counts, isF16 ? 6 : 9],
            decode: (offset, counts, buf) => {
                offset += blockOffset;
                let x: number, y: number, z: number;
                for (let i = 0; i < counts; i++) {
                    if (isF16) {
                        const o = i * 6;
                        x = fromHalf((buf[o + 1] << 8) | buf[o]);
                        y = fromHalf((buf[o + 3] << 8) | buf[o + 2]);
                        z = fromHalf((buf[o + 5] << 8) | buf[o + 4]);
                    } else {
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
                offset += blockOffset;
                for (let i = 0; i < counts; i++) {
                    setAlpha(offset + i, buf[i] / 255);
                }
            },
        },
        {
            init: () => [counts, 3],
            decode: (offset, counts, buf) => {
                offset += blockOffset;
                for (let i = 0; i < counts; i++) {
                    const o = i * 3;
                    setColor(offset + i, COLOR_LUT[buf[o]], COLOR_LUT[buf[o + 1]], COLOR_LUT[buf[o + 2]]);
                }
            },
        },
        {
            init: () => [counts, 3],
            decode: (offset, counts, buf) => {
                offset += blockOffset;
                for (let i = 0; i < counts; i++) {
                    const o = i * 3;
                    setScale(offset + i, SCALE_LUT[buf[o]], SCALE_LUT[buf[o + 1]], SCALE_LUT[buf[o + 2]]);
                }
            },
        },
        {
            init: () => [counts, useSmallestThreeQuat ? 4 : 3],
            decode: (offset, counts, buf) => {
                offset += blockOffset;
                let qx: number, qy: number, qz: number, qw: number;
                for (let i = 0; i < counts; i++) {
                    if (!useSmallestThreeQuat) {
                        const o = i * 3;
                        qx = buf[o] / 127.5 - 1;
                        qy = buf[o + 1] / 127.5 - 1;
                        qz = buf[o + 2] / 127.5 - 1;
                        qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
                    } else {
                        const o = i * 4;
                        const packed = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
                        const largest = packed >>> 30;
                        let temp = packed;
                        let sum = 0;
                        for (let j = 3; j >= 0; j--) {
                            if (j === largest) {
                                continue;
                            }
                            const mag = temp & 0x1ff;
                            const sign = (temp >>> 9) & 1;
                            temp >>>= 10;

                            const v = Math.SQRT1_2 * (mag / 0x1ff) * (sign ? -1 : 1);
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
            init: () => [shCounts > 0 ? counts : 0, shCounts],
            decode: (offset, counts, buf) => {
                offset += blockOffset;
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
}

async function pipeZstdStream(
    cursor: ByteStreamCursor,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    compressedSize: number,
    uncompressedSize: number,
    streamIndex: number,
) {
    const zstd = Duplex.toWeb(createZstdDecompress({ chunkSize: STREAM_CHUNK_BYTE_LENGTH }));
    const zstdWriter = zstd.writable.getWriter();
    let produced = 0;
    const pipePromise = zstd.readable.pipeTo(
        new WritableStream<Uint8Array>({
            async write(chunk) {
                produced += chunk.byteLength;
                if (produced > uncompressedSize) {
                    throw new Error(`Invalid SPZ v4 decompressed size at index ${streamIndex}`);
                }
                await writer.write(chunk);
            },
        }),
    );
    const feedPromise = (async () => {
        await cursor.readChunks(compressedSize, chunk => zstdWriter.write(chunk));
        await zstdWriter.close();
    })();

    try {
        await Promise.all([feedPromise, pipePromise]);
    } catch (error) {
        await zstdWriter.abort(error).catch(() => {});
        await Promise.allSettled([feedPromise, pipePromise]);
        throw error;
    }

    if (produced !== uncompressedSize) {
        throw new Error(`Invalid SPZ v4 decompressed size at index ${streamIndex}`);
    }
}

export class SpzFile implements IFile {
    readonly version: number;
    readonly compressLevel: number;

    constructor(version: number = SPZ_LEGACY_VERSION, compressLevel: number = version === SPZ_LEGACY_VERSION ? 6 : 7) {
        if (version !== 3 && version !== 4) {
            throw new Error(`Unsupported SPZ version: ${version}`);
        }
        this.version = version;
        this.compressLevel = compressLevel;
    }

    private async readStream(stream: ReadableStream<Uint8Array>, data: SplatData) {
        const cursor = new ByteStreamCursor(stream);
        const header = await cursor.readExact(32);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== SPZ_MAGIC) {
            throw new Error('Invalid SPZ file');
        }
        const version = view.getUint32(4, true);
        if (version !== SPZ_VERSION) {
            throw new Error(`Unsupported SPZ version: ${version}`);
        }
        const counts = view.getUint32(8, true);
        const shDegree = view.getUint8(12);
        const shCounts = SH_MAPS[shDegree];
        if (shCounts === undefined) {
            throw new Error(`Unsupported SPZ SH degree: ${shDegree}`);
        }
        const fractionalBits = view.getUint8(13);
        const numStreams = view.getUint8(15);
        const tocByteOffset = view.getUint32(16, true);
        const expectedSizes = [counts * 9, counts, counts * 3, counts * 3, counts * 4];
        if (shDegree > 0) {
            expectedSizes.push(counts * shCounts);
        }
        if (numStreams !== expectedSizes.length) {
            throw new Error(`Invalid SPZ v4 stream count: ${numStreams}`);
        }
        if (tocByteOffset < 32) {
            throw new Error(`Invalid SPZ v4 TOC offset: ${tocByteOffset}`);
        }

        if (tocByteOffset > 32) {
            await cursor.skip(tocByteOffset - 32);
        }

        const toc = await cursor.readExact(numStreams * 16);
        const tocView = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
        const blockOffset = await data.initBlock(counts, shDegree);
        const attributeStream = new TransformStream<Uint8Array, Uint8Array>();
        const attributeCursor = new ByteStreamCursor(attributeStream.readable);
        const decodeAttributePromise = decodeAttribute(
            attributeCursor,
            data,
            blockOffset,
            version,
            counts,
            shCounts,
            fractionalBits,
        );
        const writer = attributeStream.writable.getWriter();
        for (let i = 0; i < expectedSizes.length; i++) {
            const entryOffset = i * 16;
            const compressedSize64 = tocView.getBigUint64(entryOffset, true);
            const uncompressedSize64 = tocView.getBigUint64(entryOffset + 8, true);
            if (compressedSize64 > MAX_SAFE_STREAM_SIZE || uncompressedSize64 > MAX_SAFE_STREAM_SIZE) {
                throw new Error(`SPZ stream size is too large at index ${i}`);
            }

            const compressedSize = Number(compressedSize64);
            const uncompressedSize = Number(uncompressedSize64);
            if (uncompressedSize !== expectedSizes[i]) {
                throw new Error(`Invalid SPZ v4 stream size at index ${i}`);
            }
            await pipeZstdStream(cursor, writer, compressedSize, uncompressedSize, i);
        }
        await writer.close();
        await decodeAttributePromise;
    }

    private async readLegacyStream(stream: ReadableStream<Uint8Array>, data: SplatData) {
        const source = stream.pipeThrough<Uint8Array>(
            new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>,
        );
        const cursor = new ByteStreamCursor(source);
        const header = await cursor.readExact(16);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== SPZ_MAGIC) {
            throw new Error('Invalid SPZ file');
        }

        const version = view.getUint32(4, true);
        if (version < 1 || version > SPZ_LEGACY_VERSION) {
            throw new Error(`Unsupported SPZ version: ${version}`);
        }
        const counts = view.getUint32(8, true);
        const shDegree = view.getUint8(12);
        const shCounts = SH_MAPS[shDegree];
        if (shCounts === undefined) {
            throw new Error(`Unsupported SPZ SH degree: ${shDegree}`);
        }
        const fractionalBits = view.getUint8(13);
        const blockOffset = await data.initBlock(counts, shDegree);
        await decodeAttribute(cursor, data, blockOffset, version, counts, shCounts, fractionalBits);
    }

    async read(stream: ReadableStream<Uint8Array>, _contentLength: number, data: SplatData) {
        const [probeStream, dataStream] = stream.tee();
        const cursor = new ByteStreamCursor(probeStream);
        const magicCode = await cursor.readUint32(true);
        cursor.cancel();
        if (magicCode === SPZ_MAGIC) {
            await this.readStream(dataStream, data);
        } else {
            await this.readLegacyStream(dataStream, data);
        }
        data.finishBlock();
    }

    private async writeStream(stream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        const { counts, shCounts, table } = data;

        const chunks: Array<{ buffer: Uint8Array; compressedSize: number; uncompressedSize: number }> = [];
        {
            const xCol = table[ColIdx.x];
            const yCol = table[ColIdx.y];
            const zCol = table[ColIdx.z];
            const chunk = new Uint8Array(counts * 9);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                const o = i * 9;
                const x = clamp(xCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o] = x & 0xff;
                chunk[o + 1] = (x >> 8) & 0xff;
                chunk[o + 2] = (x >> 16) & 0xff;
                const y = clamp(yCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o + 3] = y & 0xff;
                chunk[o + 4] = (y >> 8) & 0xff;
                chunk[o + 5] = (y >> 16) & 0xff;
                const z = clamp(zCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o + 6] = z & 0xff;
                chunk[o + 7] = (z >> 8) & 0xff;
                chunk[o + 8] = (z >> 16) & 0xff;
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }
        {
            const alpha = data.table[ColIdx.a];
            const chunk = new Uint8Array(counts);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                chunk[i] = clamp(Math.round(alpha[index] * 255), 0, 255);
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer: buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }
        {
            const rCol = table[ColIdx.r];
            const gCol = table[ColIdx.g];
            const bCol = table[ColIdx.b];
            const chunk = new Uint8Array(counts * 3);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                const o = i * 3;
                chunk[o] = clamp(Math.round(((rCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 1] = clamp(Math.round(((gCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 2] = clamp(Math.round(((bCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }
        {
            const sxCol = table[ColIdx.sx];
            const syCol = table[ColIdx.sy];
            const szCol = table[ColIdx.sz];
            const chunk = new Uint8Array(counts * 3);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                const o = i * 3;
                chunk[o] = clamp(Math.round((Math.log(sxCol[index]) + 10) * 16), 0, 255);
                chunk[o + 1] = clamp(Math.round((Math.log(syCol[index]) + 10) * 16), 0, 255);
                chunk[o + 2] = clamp(Math.round((Math.log(szCol[index]) + 10) * 16), 0, 255);
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }
        {
            const qxCol = table[ColIdx.qx];
            const qyCol = table[ColIdx.qy];
            const qzCol = table[ColIdx.qz];
            const qwCol = table[ColIdx.qw];
            const chunk = new Uint8Array(counts * 4);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                const o = i * 4;
                rotation[0] = qxCol[index];
                rotation[1] = qyCol[index];
                rotation[2] = qzCol[index];
                rotation[3] = qwCol[index];
                let largest = 0;
                for (let j = 1; j < 4; j++) {
                    if (Math.abs(rotation[j]) > Math.abs(rotation[largest])) {
                        largest = j;
                    }
                }
                const negate = rotation[largest] < 0 ? 1 : 0;
                let packed = largest;
                for (let j = 0; j < 4; j++) {
                    if (j !== largest) {
                        const sign = (rotation[j] < 0 ? 1 : 0) ^ negate;
                        const magnitude = Math.floor(0x1ff * (Math.abs(rotation[j]) / Math.SQRT1_2) + 0.5);
                        packed = (packed << 10) | (sign << 9) | magnitude;
                    }
                }
                chunk[o] = packed & 0xff;
                chunk[o + 1] = (packed >> 8) & 0xff;
                chunk[o + 2] = (packed >> 16) & 0xff;
                chunk[o + 3] = (packed >> 24) & 0xff;
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }
        if (shCounts > 0) {
            const chunk = new Uint8Array(counts * shCounts);
            for (let i = 0; i < counts; i++) {
                const index = indices[i];
                const o = i * shCounts;
                for (let j = 0; j < shCounts; j++) {
                    const step = j < 9 ? SH_SCALE1 : SH_SCALE2;
                    chunk[o + j] = clamp(
                        Math.floor((Math.round(table[ColIdx.shOffset + j][index] * 128) + 128 + step / 2) / step) *
                            step,
                        0,
                        255,
                    );
                }
            }
            const buffer = zstdCompressSync(chunk, {
                chunkSize: STREAM_CHUNK_BYTE_LENGTH,
                params: {
                    [zlibConstant.ZSTD_c_compressionLevel]: this.compressLevel,
                },
            });
            chunks.push({ buffer, compressedSize: buffer.byteLength, uncompressedSize: chunk.byteLength });
        }

        const writer = stream.getWriter();
        const header = new Uint8Array(SPZ_STREAM_HEADER_BYTE_LENGTH);
        const view = new DataView(header.buffer);
        view.setUint32(0, SPZ_MAGIC, true);
        view.setUint32(4, SPZ_VERSION, true);
        view.setUint32(8, data.counts, true);
        view.setUint8(12, data.shDegree);
        view.setUint8(13, SPZ_FRACTIONAL_BITS);
        view.setUint8(14, FLAG_ANTIALIASED);
        view.setUint8(15, chunks.length);
        view.setUint32(16, SPZ_STREAM_HEADER_BYTE_LENGTH, true);
        await writer.write(header);

        const toc = new Uint8Array(chunks.length * SPZ_TOC_ENTRY_BYTE_LENGTH);
        const tocView = new DataView(toc.buffer);
        for (let i = 0; i < chunks.length; i++) {
            const offset = i * SPZ_TOC_ENTRY_BYTE_LENGTH;
            tocView.setBigUint64(offset, BigInt(chunks[i].compressedSize), true);
            tocView.setBigUint64(offset + 8, BigInt(chunks[i].uncompressedSize), true);
        }
        await writer.write(toc);

        for (let i = 0; i < chunks.length; i++) {
            const { buffer } = chunks[i];
            await writer.write(buffer);
        }
        await writer.close();
    }

    private async writeLegacyStream(writeStream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        let writer: WritableStreamDefaultWriter<Uint8Array>;
        let pipePromise = Promise.resolve();
        if (this.compressLevel === -1) {
            writer = writeStream.getWriter();
        } else {
            const gzip = Duplex.toWeb(createGzip({ level: this.compressLevel, chunkSize: STREAM_CHUNK_BYTE_LENGTH }));
            writer = gzip.writable.getWriter();
            pipePromise = gzip.readable.pipeTo(writeStream);
        }

        const header = new Uint8Array(16);
        const view = new DataView(header.buffer);
        view.setUint32(0, SPZ_MAGIC, true);
        view.setUint32(4, SPZ_LEGACY_VERSION, true);
        view.setUint32(8, data.counts, true);
        view.setUint8(12, data.shDegree);
        view.setUint8(13, SPZ_FRACTIONAL_BITS);
        view.setUint8(14, FLAG_ANTIALIASED);
        await writer.write(header);

        const { counts, shCounts, table } = data;
        const chunkWrite = async (
            itemSize: number,
            fill: (chunk: Uint8Array, offset: number, counts: number) => void,
        ) => {
            const chunkSize = Math.floor(STREAM_CHUNK_BYTE_LENGTH / itemSize);
            for (let offset = 0; offset < counts; offset += chunkSize) {
                const currentChunkCounts = Math.min(chunkSize, counts - offset);
                const chunk = new Uint8Array(currentChunkCounts * itemSize);
                fill(chunk, offset, currentChunkCounts);
                writer.write(chunk);
                if (writer.desiredSize! <= 0) {
                    await writer.ready;
                }
            }
        };

        const xCol = table[ColIdx.x];
        const yCol = table[ColIdx.y];
        const zCol = table[ColIdx.z];
        await chunkWrite(9, (chunk, offset, counts) => {
            for (let i = 0; i < counts; i++) {
                const index = indices[offset + i];
                const o = i * 9;
                const x = clamp(xCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o] = x & 0xff;
                chunk[o + 1] = (x >> 8) & 0xff;
                chunk[o + 2] = (x >> 16) & 0xff;
                const y = clamp(yCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o + 3] = y & 0xff;
                chunk[o + 4] = (y >> 8) & 0xff;
                chunk[o + 5] = (y >> 16) & 0xff;
                const z = clamp(zCol[index] * SPZ_FRACTIONAL, -0x7fffff, 0x7fffff);
                chunk[o + 6] = z & 0xff;
                chunk[o + 7] = (z >> 8) & 0xff;
                chunk[o + 8] = (z >> 16) & 0xff;
            }
        });

        const alpha = data.table[ColIdx.a];
        await chunkWrite(1, (chunk, offset, counts) => {
            for (let i = 0; i < counts; i++) {
                const index = indices[offset + i];
                chunk[i] = clamp(Math.round(alpha[index] * 255), 0, 255);
            }
        });

        const rCol = table[ColIdx.r];
        const gCol = table[ColIdx.g];
        const bCol = table[ColIdx.b];
        await chunkWrite(3, (chunk, offset, counts) => {
            for (let i = 0; i < counts; i++) {
                const index = indices[offset + i];
                const o = i * 3;
                chunk[o] = clamp(Math.round(((rCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 1] = clamp(Math.round(((gCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                chunk[o + 2] = clamp(Math.round(((bCol[index] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
            }
        });

        const sxCol = table[ColIdx.sx];
        const syCol = table[ColIdx.sy];
        const szCol = table[ColIdx.sz];
        await chunkWrite(3, (chunk, offset, counts) => {
            for (let i = 0; i < counts; i++) {
                const index = indices[offset + i];
                const o = i * 3;
                chunk[o] = clamp(Math.round((Math.log(sxCol[index]) + 10) * 16), 0, 255);
                chunk[o + 1] = clamp(Math.round((Math.log(syCol[index]) + 10) * 16), 0, 255);
                chunk[o + 2] = clamp(Math.round((Math.log(szCol[index]) + 10) * 16), 0, 255);
            }
        });

        const qxCol = table[ColIdx.qx];
        const qyCol = table[ColIdx.qy];
        const qzCol = table[ColIdx.qz];
        const qwCol = table[ColIdx.qw];
        await chunkWrite(4, (chunk, offset, counts) => {
            for (let i = 0; i < counts; i++) {
                const index = indices[offset + i];
                const o = i * 4;
                rotation[0] = qxCol[index];
                rotation[1] = qyCol[index];
                rotation[2] = qzCol[index];
                rotation[3] = qwCol[index];
                let largest = 0;
                for (let j = 1; j < 4; j++) {
                    if (Math.abs(rotation[j]) > Math.abs(rotation[largest])) {
                        largest = j;
                    }
                }
                const negate = rotation[largest] < 0 ? 1 : 0;
                let packed = largest;
                for (let j = 0; j < 4; j++) {
                    if (j !== largest) {
                        const sign = (rotation[j] < 0 ? 1 : 0) ^ negate;
                        const magnitude = Math.floor(0x1ff * (Math.abs(rotation[j]) / Math.SQRT1_2) + 0.5);
                        packed = (packed << 10) | (sign << 9) | magnitude;
                    }
                }
                chunk[o] = packed & 0xff;
                chunk[o + 1] = (packed >> 8) & 0xff;
                chunk[o + 2] = (packed >> 16) & 0xff;
                chunk[o + 3] = (packed >> 24) & 0xff;
            }
        });

        if (shCounts > 0) {
            await chunkWrite(shCounts, (chunk, offset, counts) => {
                for (let i = 0; i < counts; i++) {
                    const index = indices[offset + i];
                    const o = i * shCounts;
                    for (let j = 0; j < shCounts; j++) {
                        const step = j < 9 ? SH_SCALE1 : SH_SCALE2;
                        chunk[o + j] = clamp(
                            Math.floor((Math.round(table[ColIdx.shOffset + j][index] * 128) + 128 + step / 2) / step) *
                                step,
                            0,
                            255,
                        );
                    }
                }
            });
        }

        await writer.close();
        await pipePromise;
    }

    async write(writeStream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        if (this.version === SPZ_VERSION) {
            await this.writeStream(writeStream, data, indices);
        } else {
            await this.writeLegacyStream(writeStream, data, indices);
        }
    }
}
