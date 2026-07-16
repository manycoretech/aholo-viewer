import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { ColIdx, type SplatData } from '../SplatData.js';
import {
    clamp,
    decode111011s,
    decodeQuatOct,
    encode111011s,
    encodeQuatOct,
    fromHalf,
    toHalf,
    logger,
    computeDenseBox,
    ByteStreamCursor,
    StreamChunkDecoder,
    duplexToWeb,
} from '../utils/index.js';
import type { IFile } from './IFile.js';
import { decodeWebP, encodeWebP, WebPLosslessProfile } from '../native/index.js';
import { SH_C0, SH_MAPS } from '../constant.js';

export enum PackLayout {
    Low = 'low',
    High = 'high',
}

interface Metadata {
    version: number;
    layout: PackLayout;
    counts: number;
    shDegree: number;
    box: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

const ESZ_MAGIC = 0x262834;
const ESZ_VERSION = 2;
const STREAM_CHUNK_BYTE_LENGTH = 128 * 1024;
const HIGH_PRECISION_STRIDE = 16;
const HIGH_PRECISION_BATCH_COUNTS = STREAM_CHUNK_BYTE_LENGTH / HIGH_PRECISION_STRIDE;

const TEMP_ROT = new Float32Array(4);
const PERM_TABLE = [
    // original quat idx ---> actual storage idx
    [0, 1, 2, 3],
    [3, 1, 2, 0],
    [1, 3, 2, 0],
    [1, 2, 3, 0],
];
const WRITE_PERM_TABLE = [
    [1, 2, 3],
    [0, 2, 3],
    [0, 1, 3],
    [0, 1, 2],
];
const COLOR_SCALE = SH_C0 / 0.15;
const SH_SCALE1 = 1 << 3;
const SH_SCALE2 = 1 << 4;
const SCALE_LUT = new Float32Array(256);
const COLOR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    SCALE_LUT[i] = Math.exp(i / 16 - 10);
    COLOR_LUT[i] = (i / 255 - 0.5) * COLOR_SCALE + 0.5;
}
const WEBP_LOSSLESS_PROFILE = new WebPLosslessProfile();

function logTransform(value: number) {
    return Math.sign(value) * Math.log(Math.abs(value) + 1);
}

function createSegmentHeader(length: number) {
    if (length > 0xffffffff) {
        throw new Error(`Invalid ESZ segment length: ${length}`);
    }
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, length, true);
    return header;
}

export class EszFile implements IFile {
    /**
     * @internal
     */
    version: number = ESZ_VERSION;
    /**
     * @internal
     */
    layout: PackLayout;

    constructor(highPrecision: boolean = true) {
        this.layout = highPrecision ? PackLayout.High : PackLayout.Low;
    }

    private async readLowPrecisionLayout(
        data: SplatData,
        blockOffset: number,
        meta: Metadata,
        cursor: ByteStreamCursor,
    ) {
        const { table } = data;
        const setCenter = data.setCenter.bind(data) as SplatData['setCenter'];
        const setScale = data.setScale.bind(data) as SplatData['setScale'];
        const setQuat = data.setQuat.bind(data) as SplatData['setQuat'];
        const setColor = data.setColor.bind(data) as SplatData['setColor'];
        const setAlpha = data.setAlpha.bind(data) as SplatData['setAlpha'];

        const {
            counts,
            shDegree,
            box: {
                min: [boxMinX, boxMinY, boxMinZ],
                max: [boxMaxX, boxMaxY, boxMaxZ],
            },
        } = meta;
        const minX = logTransform(boxMinX);
        const minY = logTransform(boxMinY);
        const minZ = logTransform(boxMinZ);
        const maxX = logTransform(boxMaxX);
        const maxY = logTransform(boxMaxY);
        const maxZ = logTransform(boxMaxZ);
        const rangeX = (maxX - minX) / 65535;
        const rangeY = (maxY - minY) / 65535;
        const rangeZ = (maxZ - minZ) / 65535;
        const meansLowLength = await cursor.readUint32(true);
        const meansLow = decodeWebP(await cursor.readExact(meansLowLength)).data;

        {
            const length = await cursor.readUint32(true);
            const buffer = decodeWebP(await cursor.readExact(length)).data;
            for (let i = 0; i < counts; i++) {
                const target = blockOffset + i;
                const o = i * 4;
                const x = minX + rangeX * (meansLow[o + 0] + (buffer[o + 0] << 8));
                const y = minY + rangeY * (meansLow[o + 1] + (buffer[o + 1] << 8));
                const z = minZ + rangeZ * (meansLow[o + 2] + (buffer[o + 2] << 8));
                setCenter(
                    target,
                    Math.sign(x) * (Math.exp(Math.abs(x)) - 1),
                    Math.sign(y) * (Math.exp(Math.abs(y)) - 1),
                    Math.sign(z) * (Math.exp(Math.abs(z)) - 1),
                );
            }
        }

        {
            const length = await cursor.readUint32(true);
            const buffer = decodeWebP(await cursor.readExact(length)).data;
            for (let i = 0; i < counts; i++) {
                const target = blockOffset + i;
                const o = i * 4;
                setScale(target, SCALE_LUT[buffer[o + 0]], SCALE_LUT[buffer[o + 1]], SCALE_LUT[buffer[o + 2]]);
            }
        }

        {
            const length = await cursor.readUint32(true);
            const buffer = decodeWebP(await cursor.readExact(length)).data;
            for (let i = 0; i < counts; i++) {
                const target = blockOffset + i;
                const o = i * 4;
                TEMP_ROT[0] = (buffer[o + 0] / 255 - 0.5) * Math.SQRT2;
                TEMP_ROT[1] = (buffer[o + 1] / 255 - 0.5) * Math.SQRT2;
                TEMP_ROT[2] = (buffer[o + 2] / 255 - 0.5) * Math.SQRT2;
                TEMP_ROT[3] = Math.sqrt(
                    Math.max(
                        0,
                        1.0 - TEMP_ROT[0] * TEMP_ROT[0] - TEMP_ROT[1] * TEMP_ROT[1] - TEMP_ROT[2] * TEMP_ROT[2],
                    ),
                );
                const perm = PERM_TABLE[buffer[o + 3] - 252];
                setQuat(target, TEMP_ROT[perm[0]], TEMP_ROT[perm[1]], TEMP_ROT[perm[2]], TEMP_ROT[perm[3]]);
            }
        }

        {
            const length = await cursor.readUint32(true);
            const buffer = decodeWebP(await cursor.readExact(length)).data;
            for (let i = 0; i < counts; i++) {
                const target = blockOffset + i;
                const o = i * 4;
                setColor(target, COLOR_LUT[buffer[o + 0]], COLOR_LUT[buffer[o + 1]], COLOR_LUT[buffer[o + 2]]);
                setAlpha(target, buffer[o + 3] / 255);
            }
        }

        if (shDegree > 0) {
            const shCounts = SH_MAPS[shDegree];
            const shCoeffs = shCounts / 3;
            const length = await cursor.readUint32(true);
            const buffer = decodeWebP(await cursor.readExact(length)).data;
            for (let i = 0; i < counts; i++) {
                const target = blockOffset + i;
                const o = i * shCoeffs * 4;
                for (let j = 0; j < shCoeffs; j++) {
                    const sourceOffset = o + j * 4;
                    const targetOffset = ColIdx.shOffset + j * 3;
                    table[targetOffset + 0][target] = (buffer[sourceOffset + 0] - 128) / 128;
                    table[targetOffset + 1][target] = (buffer[sourceOffset + 1] - 128) / 128;
                    table[targetOffset + 2][target] = (buffer[sourceOffset + 2] - 128) / 128;
                }
            }
        }
    }

    private async readHighPrecisionLayout(
        data: SplatData,
        blockOffset: number,
        meta: Metadata,
        cursor: ByteStreamCursor,
    ) {
        const { table } = data;
        const { counts, shDegree } = meta;
        const setCenter = data.setCenter.bind(data) as SplatData['setCenter'];
        const setScale = data.setScale.bind(data) as SplatData['setScale'];
        const setQuat = data.setQuat.bind(data) as SplatData['setQuat'];
        const setColor = data.setColor.bind(data) as SplatData['setColor'];
        const setAlpha = data.setAlpha.bind(data) as SplatData['setAlpha'];

        const decoder = new StreamChunkDecoder(cursor);
        {
            const blockByteLength = await cursor.readUint32(true);
            const expectedByteLength = counts * 16;
            if (blockByteLength !== expectedByteLength) {
                throw new Error(`Invalid ESZ segment length: expected ${expectedByteLength}, got ${blockByteLength}`);
            }
            await decoder.decode([
                {
                    init: () => [counts, 16],
                    decode: (start, batchCounts, buffer) => {
                        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                        for (let i = 0; i < batchCounts; i++) {
                            const target = blockOffset + start + i;
                            const o = i * 16;
                            setCenter(
                                target,
                                view.getFloat32(o + 0, true),
                                view.getFloat32(o + 4, true),
                                view.getFloat32(o + 8, true),
                            );
                            setAlpha(target, fromHalf(view.getUint16(o + 12, true)));
                        }
                    },
                },
            ]);
        }
        {
            const blockByteLength = await cursor.readUint32(true);
            const expectedByteLength = counts * 16;
            if (blockByteLength !== expectedByteLength) {
                throw new Error(`Invalid ESZ segment length: expected ${expectedByteLength}, got ${blockByteLength}`);
            }
            await decoder.decode([
                {
                    init: () => [counts, 16],
                    decode: (start, batchCounts, buffer) => {
                        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                        for (let i = 0; i < batchCounts; i++) {
                            const target = blockOffset + start + i;
                            const o = i * 16;
                            setColor(
                                target,
                                fromHalf(view.getUint16(o + 0, true)),
                                fromHalf(view.getUint16(o + 2, true)),
                                fromHalf(view.getUint16(o + 4, true)),
                            );
                            setScale(
                                target,
                                Math.exp(fromHalf(view.getUint16(o + 6, true))),
                                Math.exp(fromHalf(view.getUint16(o + 8, true))),
                                Math.exp(fromHalf(view.getUint16(o + 10, true))),
                            );

                            const packedQuat = view.getUint32(o + 12, true);
                            const quat = decodeQuatOct(
                                ((packedQuat & 0x3ff) / 1023) * 2 - 1,
                                (((packedQuat >>> 10) & 0x3ff) / 1023) * 2 - 1,
                                ((packedQuat >>> 20) & 0xfff) / 4095,
                            );
                            setQuat(target, quat[0], quat[1], quat[2], quat[3]);
                        }
                    },
                },
            ]);
        }

        const shCoeffs = SH_MAPS[shDegree] / 3;
        const sh = new Array(3);
        for (let groupOffset = 0; groupOffset < shCoeffs; groupOffset += 4) {
            const groupCounts = Math.min(4, shCoeffs - groupOffset);
            const byteLength = await cursor.readUint32(true);
            const expectedByteLength = counts * 16;
            if (byteLength !== expectedByteLength) {
                throw new Error(`Invalid ESZ segment length: expected ${expectedByteLength}, got ${byteLength}`);
            }
            await decoder.decode([
                {
                    init: () => [counts, 16],
                    decode: (start, batchCounts, buffer) => {
                        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                        for (let i = 0; i < batchCounts; i++) {
                            const target = blockOffset + start + i;
                            const o = i * 16;
                            for (let j = 0; j < groupCounts; j++) {
                                decode111011s(view.getUint32(o + j * 4, true), sh, 0);
                                const shOffset = ColIdx.shOffset + (groupOffset + j) * 3;
                                table[shOffset + 0][target] = sh[0];
                                table[shOffset + 1][target] = sh[1];
                                table[shOffset + 2][target] = sh[2];
                            }
                        }
                    },
                },
            ]);
        }
    }

    async read(stream: ReadableStream<Uint8Array>, _contentLength: number, data: SplatData) {
        const zstd = duplexToWeb(createZstdDecompress({ chunkSize: STREAM_CHUNK_BYTE_LENGTH }));
        const cursor = new ByteStreamCursor(stream.pipeThrough(zstd as any));

        if ((await cursor.readUint32(true)) !== ESZ_MAGIC) {
            throw new Error('Invalid ESZ file: missing EGS magic');
        }

        const metaLength = await cursor.readUint32(true);
        const metaBuffer = await cursor.readExact(metaLength);
        const meta = JSON.parse(new TextDecoder().decode(metaBuffer)) as Metadata;
        if (meta.version !== ESZ_VERSION) {
            throw new Error(`Unsupported ESZ version: ${meta.version}`);
        }
        if (meta.layout !== PackLayout.Low && meta.layout !== PackLayout.High) {
            throw new Error(`Unsupported ESZ layout: ${meta.layout}`);
        }

        this.version = meta.version;
        this.layout = meta.layout;
        const offset = await data.initBlock(meta.counts, meta.shDegree);
        switch (meta.layout) {
            case PackLayout.High:
                await this.readHighPrecisionLayout(data, offset, meta, cursor);
                break;
            case PackLayout.Low:
                await this.readLowPrecisionLayout(data, offset, meta, cursor);
                break;
        }
        data.finishBlock();
    }

    private async writeLowPrecisionLayout(
        writer: WritableStreamDefaultWriter<Uint8Array>,
        data: SplatData,
        indices: Uint32Array,
        meta: Metadata,
    ) {
        const { counts, shDegree, shCounts, table } = data;
        const width = Math.ceil(Math.sqrt(counts) / 4) * 4;
        const height = Math.ceil(counts / width / 4) * 4;

        {
            logger.time('ESZ encoding means');
            const {
                min: [boxMinX, boxMinY, boxMinZ],
                max: [boxMaxX, boxMaxY, boxMaxZ],
            } = meta.box;
            const minX = logTransform(boxMinX);
            const minY = logTransform(boxMinY);
            const minZ = logTransform(boxMinZ);
            const maxX = logTransform(boxMaxX);
            const maxY = logTransform(boxMaxY);
            const maxZ = logTransform(boxMaxZ);
            const scaleX = 65535 / Math.max(maxX - minX, 1e-9);
            const scaleY = 65535 / Math.max(maxY - minY, 1e-9);
            const scaleZ = 65535 / Math.max(maxZ - minZ, 1e-9);

            const xCol = table[ColIdx.x];
            const yCol = table[ColIdx.y];
            const zCol = table[ColIdx.z];
            const meansL = new Uint8Array(width * height * 4).fill(0xff);
            const meansU = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                const x = clamp(Math.round((logTransform(xCol[idx]) - minX) * scaleX), 0, 65535);
                const y = clamp(Math.round((logTransform(yCol[idx]) - minY) * scaleY), 0, 65535);
                const z = clamp(Math.round((logTransform(zCol[idx]) - minZ) * scaleZ), 0, 65535);
                meansL[i * 4 + 0] = x & 0xff;
                meansL[i * 4 + 1] = y & 0xff;
                meansL[i * 4 + 2] = z & 0xff;
                meansU[i * 4 + 0] = (x >> 8) & 0xff;
                meansU[i * 4 + 1] = (y >> 8) & 0xff;
                meansU[i * 4 + 2] = (z >> 8) & 0xff;
            }
            const encodeL = encodeWebP(meansL, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(encodeL.byteLength));
            await writer.write(encodeL);
            const encodeU = encodeWebP(meansU, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(encodeU.byteLength));
            await writer.write(encodeU);
            logger.timeEnd('ESZ encoding means');
        }

        {
            logger.time('ESZ encoding scales');
            const sxCol = table[ColIdx.sx];
            const syCol = table[ColIdx.sy];
            const szCol = table[ColIdx.sz];
            const scales = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                scales[i * 4 + 0] = clamp(Math.round((Math.log(sxCol[idx]) + 10) * 16), 0, 255);
                scales[i * 4 + 1] = clamp(Math.round((Math.log(syCol[idx]) + 10) * 16), 0, 255);
                scales[i * 4 + 2] = clamp(Math.round((Math.log(szCol[idx]) + 10) * 16), 0, 255);
            }
            const result = encodeWebP(scales, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(result.byteLength));
            await writer.write(result);
            logger.timeEnd('ESZ encoding scales');
        }

        {
            logger.time('ESZ encoding quats');
            const qxCol = table[ColIdx.qx];
            const qyCol = table[ColIdx.qy];
            const qzCol = table[ColIdx.qz];
            const qwCol = table[ColIdx.qw];
            const quats = new Uint8Array(width * height * 4);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                TEMP_ROT[0] = qwCol[idx];
                TEMP_ROT[1] = qxCol[idx];
                TEMP_ROT[2] = qyCol[idx];
                TEMP_ROT[3] = qzCol[idx];
                const length = Math.sqrt(
                    TEMP_ROT[0] * TEMP_ROT[0] +
                        TEMP_ROT[1] * TEMP_ROT[1] +
                        TEMP_ROT[2] * TEMP_ROT[2] +
                        TEMP_ROT[3] * TEMP_ROT[3],
                );
                for (let j = 0; j < TEMP_ROT.length; j++) {
                    TEMP_ROT[j] /= length || 1;
                }
                let maxComp = 0;
                for (let j = 1; j < TEMP_ROT.length; j++) {
                    if (Math.abs(TEMP_ROT[j]) > Math.abs(TEMP_ROT[maxComp])) {
                        maxComp = j;
                    }
                }
                if (TEMP_ROT[maxComp] < 0) {
                    for (let j = 0; j < TEMP_ROT.length; j++) {
                        TEMP_ROT[j] *= -1;
                    }
                }
                for (let j = 0; j < TEMP_ROT.length; j++) {
                    TEMP_ROT[j] *= Math.SQRT2;
                }

                const perm = WRITE_PERM_TABLE[maxComp];
                quats[i * 4 + 0] = clamp(Math.round((TEMP_ROT[perm[0]] * 0.5 + 0.5) * 255), 0, 255);
                quats[i * 4 + 1] = clamp(Math.round((TEMP_ROT[perm[1]] * 0.5 + 0.5) * 255), 0, 255);
                quats[i * 4 + 2] = clamp(Math.round((TEMP_ROT[perm[2]] * 0.5 + 0.5) * 255), 0, 255);
                quats[i * 4 + 3] = 252 + maxComp;
            }
            const result = encodeWebP(quats, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(result.byteLength));
            await writer.write(result);
            logger.timeEnd('ESZ encoding quats');
        }

        {
            logger.time('ESZ encoding sh0');
            const rCol = table[ColIdx.r];
            const gCol = table[ColIdx.g];
            const bCol = table[ColIdx.b];
            const aCol = table[ColIdx.a];
            const sh0 = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                sh0[i * 4 + 0] = clamp(Math.round(((rCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 1] = clamp(Math.round(((gCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 2] = clamp(Math.round(((bCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 3] = clamp(Math.round(aCol[idx] * 255), 0, 255);
            }
            const result = encodeWebP(sh0, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(result.byteLength));
            await writer.write(result);
            logger.timeEnd('ESZ encoding sh0');
        }

        if (shDegree > 0) {
            logger.time('ESZ encoding shN');
            const shCoeffs = shCounts / 3;
            const pixels = counts * shCoeffs;
            const width = Math.ceil(Math.sqrt(pixels) / 4) * 4;
            const height = Math.ceil(pixels / width / 4) * 4;
            const shN = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                const o = i * shCoeffs;
                for (let j = 0; j < shCoeffs; j++) {
                    const scale = j < 3 ? SH_SCALE1 : SH_SCALE2;
                    const sourceOffset = ColIdx.shOffset + j * 3;
                    const targetOffset = (o + j) * 4;
                    for (let k = 0; k < 3; k++) {
                        shN[targetOffset + k] = clamp(
                            Math.floor((Math.round(table[sourceOffset + k][idx] * 128) + 128 + scale / 2) / scale) *
                                scale,
                            0,
                            255,
                        );
                    }
                }
            }
            const result = encodeWebP(shN, width, height, WEBP_LOSSLESS_PROFILE);
            await writer.write(createSegmentHeader(result.byteLength));
            await writer.write(result);
            logger.timeEnd('ESZ encoding shN');
        }
    }

    private async writeHighPrecisionLayout(
        writer: WritableStreamDefaultWriter<Uint8Array>,
        data: SplatData,
        indices: Uint32Array,
    ) {
        const { counts, shCounts, table } = data;
        const segmentByteLength = counts * HIGH_PRECISION_STRIDE;
        const buffer = new Uint8Array(Math.min(counts, HIGH_PRECISION_BATCH_COUNTS) * HIGH_PRECISION_STRIDE);
        const view = new DataView(buffer.buffer);

        {
            const xCol = table[ColIdx.x];
            const yCol = table[ColIdx.y];
            const zCol = table[ColIdx.z];
            const aCol = table[ColIdx.a];
            await writer.write(createSegmentHeader(segmentByteLength));
            for (let start = 0; start < counts; start += HIGH_PRECISION_BATCH_COUNTS) {
                const batchCounts = Math.min(HIGH_PRECISION_BATCH_COUNTS, counts - start);
                for (let i = 0; i < batchCounts; i++) {
                    const idx = indices[start + i];
                    const o = i * HIGH_PRECISION_STRIDE;
                    view.setFloat32(o + 0, xCol[idx], true);
                    view.setFloat32(o + 4, yCol[idx], true);
                    view.setFloat32(o + 8, zCol[idx], true);
                    view.setUint16(o + 12, toHalf(aCol[idx]), true);
                }
                await writer.write(buffer.subarray(0, batchCounts * HIGH_PRECISION_STRIDE));
            }
        }
        {
            const rCol = table[ColIdx.r];
            const gCol = table[ColIdx.g];
            const bCol = table[ColIdx.b];
            const sxCol = table[ColIdx.sx];
            const syCol = table[ColIdx.sy];
            const szCol = table[ColIdx.sz];
            const qxCol = table[ColIdx.qx];
            const qyCol = table[ColIdx.qy];
            const qzCol = table[ColIdx.qz];
            const qwCol = table[ColIdx.qw];
            await writer.write(createSegmentHeader(segmentByteLength));
            for (let start = 0; start < counts; start += HIGH_PRECISION_BATCH_COUNTS) {
                const batchCounts = Math.min(HIGH_PRECISION_BATCH_COUNTS, counts - start);
                for (let i = 0; i < batchCounts; i++) {
                    const idx = indices[start + i];
                    const o = i * HIGH_PRECISION_STRIDE;
                    view.setUint16(o + 0, toHalf(rCol[idx]), true);
                    view.setUint16(o + 2, toHalf(gCol[idx]), true);
                    view.setUint16(o + 4, toHalf(bCol[idx]), true);
                    view.setUint16(o + 6, toHalf(Math.log(sxCol[idx])), true);
                    view.setUint16(o + 8, toHalf(Math.log(syCol[idx])), true);
                    view.setUint16(o + 10, toHalf(Math.log(szCol[idx])), true);

                    const oct = encodeQuatOct(qxCol[idx], qyCol[idx], qzCol[idx], qwCol[idx]);
                    const quantU = clamp(((oct[0] * 0.5 + 0.5) * 1023) | 0, 0, 1023);
                    const quantV = clamp(((oct[1] * 0.5 + 0.5) * 1023) | 0, 0, 1023);
                    const angleInt = clamp((oct[2] * 4095) | 0, 0, 4095);
                    view.setUint32(o + 12, ((angleInt << 20) | (quantV << 10) | quantU) >>> 0, true);
                }
                await writer.write(buffer.subarray(0, batchCounts * HIGH_PRECISION_STRIDE));
            }
        }

        const shCoeffs = shCounts / 3;
        for (let groupOffset = 0; groupOffset < shCoeffs; groupOffset += 4) {
            const groupCounts = Math.min(4, shCoeffs - groupOffset);
            buffer.fill(0);
            await writer.write(createSegmentHeader(segmentByteLength));
            for (let start = 0; start < counts; start += HIGH_PRECISION_BATCH_COUNTS) {
                const batchCounts = Math.min(HIGH_PRECISION_BATCH_COUNTS, counts - start);
                for (let i = 0; i < batchCounts; i++) {
                    const idx = indices[start + i];
                    const o = i * HIGH_PRECISION_STRIDE;
                    for (let j = 0; j < groupCounts; j++) {
                        const shOffset = (groupOffset + j) * 3;
                        view.setUint32(
                            o + j * 4,
                            encode111011s(
                                table[ColIdx.shOffset + shOffset + 0][idx],
                                table[ColIdx.shOffset + shOffset + 1][idx],
                                table[ColIdx.shOffset + shOffset + 2][idx],
                            ),
                            true,
                        );
                    }
                }
                await writer.write(buffer.subarray(0, batchCounts * HIGH_PRECISION_STRIDE));
            }
        }
    }

    async write(stream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        const zstd = duplexToWeb(createZstdCompress({ chunkSize: STREAM_CHUNK_BYTE_LENGTH }));
        const pipePromise = zstd.readable.pipeTo(stream);
        const writer = zstd.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;

        const meta = {
            version: this.version,
            layout: this.layout,
            counts: data.counts,
            shDegree: data.shDegree,
            box: computeDenseBox(data, 1),
        };
        const metaBuffer = new TextEncoder().encode(JSON.stringify(meta));
        const header = new Uint8Array(8 + metaBuffer.byteLength);
        const view = new DataView(header.buffer);
        view.setUint32(0, ESZ_MAGIC, true);
        view.setUint32(4, metaBuffer.byteLength, true);
        header.set(metaBuffer, 8);
        await writer.write(header);

        if (this.layout === PackLayout.High) {
            logger.info('ESZ encoding high mode');
            await this.writeHighPrecisionLayout(writer, data, indices);
        } else if (this.layout === PackLayout.Low) {
            logger.info('ESZ encoding low mode');
            await this.writeLowPrecisionLayout(writer, data, indices, meta);
        } else {
            throw new Error(`Unsupported ESZ layout: ${this.layout}`);
        }
        await writer.close();
        await pipePromise;
    }
}
