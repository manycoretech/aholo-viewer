import { unzipSync, zipSync, type Zippable } from 'fflate';
import { Buffer } from 'node:buffer';
import { decodeWebP, encodeWebP, WebPLosslessProfile } from '../native/index.js';
import { type SplatData, ColIdx } from '../SplatData.js';
import { SH_C0, SH_MAPS, NUM_F_REST_TO_SH_DEGREE } from '../constant.js';
import {
    getOrCreateDevice,
    kMeans,
    logger,
    quantize1d,
    isUrl,
    extractFromRootDir,
    clamp,
    createSingleSplat,
} from '../utils/index.js';
import type { IFile } from './IFile.js';

export interface SogMetadataV1 {
    version: undefined;
    means: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    scales: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    quats: { shape: number[]; dtype: string; encoding?: string; files: string[] };
    sh0: {
        shape: number[];
        dtype: string;
        mins: number[];
        maxs: number[];
        files: string[];
    };
    shN?: {
        shape: number[];
        dtype: string;
        mins: number;
        maxs: number;
        quantization: number;
        files: string[];
    };
}

export interface SogMetadataV2 {
    version: number;
    count: number;
    means: {
        mins: number[];
        maxs: number[];
        files: string[];
    };
    scales: {
        codebook: number[];
        files: string[];
    };
    quats: { files: string[] };
    sh0: {
        codebook: number[];
        files: string[];
    };
    shN?: {
        count: number;
        bands: number;
        codebook: number[];
        files: string[];
    };
}

export type SogMetadata = SogMetadataV1 | SogMetadataV2;

const ZIP_MAGIC = 0x04034b50;
const PERM_TABLE = [
    // original quat idx ---> actual storage idx
    [0, 1, 2, 3],
    [3, 1, 2, 0],
    [1, 3, 2, 0],
    [1, 2, 3, 0],
];
const TEMP_ROT = new Float32Array(4);

function logTransform(value: number) {
    return Math.sign(value) * Math.log(Math.abs(value) + 1);
}

function writeTableData(table: Uint8Array[], indices: Uint32Array, width: number, height: number, channels = 4) {
    const data = new Uint8Array(width * height * channels);
    const numColumns = table.length;
    for (let i = 0; i < indices.length; ++i) {
        const idx = indices[i];
        data[i * channels + 0] = table[0][idx];
        data[i * channels + 1] = numColumns > 1 ? table[1][idx] : 0;
        data[i * channels + 2] = numColumns > 2 ? table[2][idx] : 0;
        data[i * channels + 3] = numColumns > 3 ? table[3][idx] : 255;
    }
    return data;
}

function buildSHTableMap(shCoeffs: number) {
    const result: number[] = [];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < shCoeffs; j++) {
            result.push(j * 3 + i);
        }
    }
    return result;
}

export class SogFile implements IFile {
    private counts: number = 0;
    private shDegree: number = 0;
    /**
     * @internal
     */
    version: number;
    /**
     * @internal
     */
    meta: SogMetadata;
    /**
     * @internal
     */
    refs: Record<string, Uint8Array> = {};

    private cached: Array<{ width: number; height: number; data: Uint8Array }>;

    constructor(readonly iterations: number = 10) {}

    async load(stream: ReadableStream<Uint8Array>, contentLength: number) {
        const buffer = new Uint8Array(contentLength);
        const reader = stream.getReader();
        let offset = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer.set(value!, offset);
            offset += value!.length;
        }

        let metaBuffer: Uint8Array = buffer;
        const view = new DataView(buffer.buffer);
        if (view.getUint32(0, true) === ZIP_MAGIC) {
            this.refs = extractFromRootDir(unzipSync(buffer));
            metaBuffer = this.refs['meta.json'];
            if (!metaBuffer) {
                throw new Error('SOG meta.json not found in the zip archive.');
            }
        }

        this.meta = JSON.parse(new TextDecoder().decode(metaBuffer));
        if (this.meta.version === undefined) {
            const { means, quats, shN } = this.meta as SogMetadataV1;
            if (quats.encoding !== 'quaternion_packed') {
                throw new Error('Unsupported quaternion encoding');
            }
            this.counts = means.shape[0];
            this.shDegree = shN ? NUM_F_REST_TO_SH_DEGREE[shN.shape[1]] : 0;
            this.version = 1;
        } else {
            const { version, count, shN } = this.meta as SogMetadataV2;
            if (version !== 2) {
                throw new Error(`Unsupported SOGS version: ${version}`);
            }
            this.counts = count;
            this.shDegree = shN?.bands ?? 0;
            this.version = version;
        }
    }

    private parse_v1(data: SplatData, offset: number) {
        const setFn = data.set.bind(data);
        const setShFn = data.setShN.bind(data);

        const { meta, counts, shDegree, cached } = this;
        const [mean0, mean1, scale0, quat0, color0, centroids, labels] = cached.map(v => v.data);
        const {
            means: {
                mins: [centerMinX, centerMinY, centerMinZ],
                maxs: [centerMaxX, centerMaxY, centerMaxZ],
            },
            scales: {
                mins: [scaleMinX, scaleMinY, scaleMinZ],
                maxs: [scaleMaxX, scaleMaxY, scaleMaxZ],
            },
            sh0: {
                mins: [colorMinR, colorMinG, colorMinB, colorMinA],
                maxs: [colorMaxR, colorMaxG, colorMaxB, colorMaxA],
            },
            shN,
        } = meta as SogMetadataV1;

        const rangeX = (centerMaxX - centerMinX) / 65535;
        const rangeY = (centerMaxY - centerMinY) / 65535;
        const rangeZ = (centerMaxZ - centerMinZ) / 65535;

        const SX_LUT = new Float32Array(256);
        const SY_LUT = new Float32Array(256);
        const SZ_LUT = new Float32Array(256);
        const scaleRangeX = (scaleMaxX - scaleMinX) / 255;
        const scaleRangeY = (scaleMaxY - scaleMinY) / 255;
        const scaleRangeZ = (scaleMaxZ - scaleMinZ) / 255;
        for (let i = 0; i < 256; i++) {
            SX_LUT[i] = Math.exp(scaleMinX + scaleRangeX * i);
            SY_LUT[i] = Math.exp(scaleMinY + scaleRangeY * i);
            SZ_LUT[i] = Math.exp(scaleMinZ + scaleRangeZ * i);
        }

        const A_LUT = new Float32Array(256);
        const colorRangeR = (colorMaxR - colorMinR) / 255;
        const colorRangeG = (colorMaxG - colorMinG) / 255;
        const colorRangeB = (colorMaxB - colorMinB) / 255;
        const colorRangeA = (colorMaxA - colorMinA) / 255;
        for (let i = 0; i < 256; i++) {
            A_LUT[i] = 1.0 / (1.0 + Math.exp(-(colorMinA + colorRangeA * i)));
        }

        const single = createSingleSplat();
        for (let i = 0; i < counts; i++) {
            const i4 = i * 4;

            const x = centerMinX + rangeX * (mean0[i4 + 0] + (mean1[i4 + 0] << 8));
            const y = centerMinY + rangeY * (mean0[i4 + 1] + (mean1[i4 + 1] << 8));
            const z = centerMinZ + rangeZ * (mean0[i4 + 2] + (mean1[i4 + 2] << 8));
            single.x = Math.sign(x) * (Math.exp(Math.abs(x)) - 1);
            single.y = Math.sign(y) * (Math.exp(Math.abs(y)) - 1);
            single.z = Math.sign(z) * (Math.exp(Math.abs(z)) - 1);

            single.sx = SX_LUT[scale0[i4 + 0]];
            single.sy = SY_LUT[scale0[i4 + 1]];
            single.sz = SZ_LUT[scale0[i4 + 2]];

            TEMP_ROT[0] = (quat0[i4 + 0] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[1] = (quat0[i4 + 1] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[2] = (quat0[i4 + 2] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[3] = Math.sqrt(
                Math.max(0, 1.0 - TEMP_ROT[0] * TEMP_ROT[0] - TEMP_ROT[1] * TEMP_ROT[1] - TEMP_ROT[2] * TEMP_ROT[2]),
            );
            const PERM = PERM_TABLE[quat0[i4 + 3] - 252];
            single.qx = TEMP_ROT[PERM[0]];
            single.qy = TEMP_ROT[PERM[1]];
            single.qz = TEMP_ROT[PERM[2]];
            single.qw = TEMP_ROT[PERM[3]];

            single.r = SH_C0 * (colorMinR + colorRangeR * color0[i4 + 0]) + 0.5;
            single.g = SH_C0 * (colorMinG + colorRangeG * color0[i4 + 1]) + 0.5;
            single.b = SH_C0 * (colorMinB + colorRangeB * color0[i4 + 2]) + 0.5;
            single.a = A_LUT[color0[i4 + 3]];

            setFn(offset + i, single);
        }

        if (shN) {
            const centroidTexWidth = cached[5].width;
            const { mins: min, maxs: max } = shN;
            const range = (max - min) / 255;
            const shCounts = SH_MAPS[shDegree];
            const sh = new Array(shCounts);
            const shCoeffs = shCounts / 3;
            for (let i = 0; i < counts; i++) {
                const i4 = i * 4;
                const label = labels[i4] + (labels[i4 + 1] << 8);
                const o = ((label >>> 6) * centroidTexWidth + (label & 63) * 15) * 4;
                for (let j = 0; j < shCoeffs; j++) {
                    sh[j * 3 + 0] = min + range * centroids[o + j * 4 + 0];
                    sh[j * 3 + 1] = min + range * centroids[o + j * 4 + 1];
                    sh[j * 3 + 2] = min + range * centroids[o + j * 4 + 2];
                }
                setShFn(offset + i, sh);
            }
        }
    }

    private parse_v2(data: SplatData, offset: number) {
        const setFn = data.set.bind(data);
        const setShFn = data.setShN.bind(data);

        const { meta, counts, shDegree, cached } = this;
        const { means, scales, sh0, shN } = meta as SogMetadataV2;
        const {
            mins: [centerMinX, centerMinY, centerMinZ],
            maxs: [centerMaxX, centerMaxY, centerMaxZ],
        } = means;
        const { codebook: scaleCodebook } = scales;
        const { codebook: sh0Codebook } = sh0;
        const [mean0, mean1, scale0, quat0, color0, centroids, labels] = cached.map(img => img.data);

        const rangeX = (centerMaxX - centerMinX) / 65535;
        const rangeY = (centerMaxY - centerMinY) / 65535;
        const rangeZ = (centerMaxZ - centerMinZ) / 65535;
        const SCALE_LUT = scaleCodebook.map(v => Math.exp(v));

        const single = createSingleSplat();
        for (let i = 0; i < counts; i++) {
            const i4 = i * 4;

            const x = centerMinX + rangeX * (mean0[i4 + 0] + (mean1[i4 + 0] << 8));
            const y = centerMinY + rangeY * (mean0[i4 + 1] + (mean1[i4 + 1] << 8));
            const z = centerMinZ + rangeZ * (mean0[i4 + 2] + (mean1[i4 + 2] << 8));
            single.x = Math.sign(x) * (Math.exp(Math.abs(x)) - 1);
            single.y = Math.sign(y) * (Math.exp(Math.abs(y)) - 1);
            single.z = Math.sign(z) * (Math.exp(Math.abs(z)) - 1);

            single.sx = SCALE_LUT[scale0[i4 + 0]];
            single.sy = SCALE_LUT[scale0[i4 + 1]];
            single.sz = SCALE_LUT[scale0[i4 + 2]];

            TEMP_ROT[0] = (quat0[i4 + 0] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[1] = (quat0[i4 + 1] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[2] = (quat0[i4 + 2] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[3] = Math.sqrt(
                Math.max(0, 1.0 - TEMP_ROT[0] * TEMP_ROT[0] - TEMP_ROT[1] * TEMP_ROT[1] - TEMP_ROT[2] * TEMP_ROT[2]),
            );
            const PERM = PERM_TABLE[quat0[i4 + 3] - 252];
            single.qx = TEMP_ROT[PERM[0]];
            single.qy = TEMP_ROT[PERM[1]];
            single.qz = TEMP_ROT[PERM[2]];
            single.qw = TEMP_ROT[PERM[3]];

            single.r = SH_C0 * sh0Codebook[color0[i4 + 0]] + 0.5;
            single.g = SH_C0 * sh0Codebook[color0[i4 + 1]] + 0.5;
            single.b = SH_C0 * sh0Codebook[color0[i4 + 2]] + 0.5;
            single.a = color0[i4 + 3] / 255;

            setFn(offset + i, single);
        }

        if (shN) {
            const { codebook } = shN;
            const shCounts = SH_MAPS[shDegree];
            const shCoeffs = shCounts / 3;
            const offsetItemSize = shCoeffs * 4;
            const sh = new Array(shCounts);
            for (let i = 0; i < counts; i++) {
                const i4 = i * 4;
                const o = (labels[i4 + 0] + (labels[i4 + 1] << 8)) * offsetItemSize;
                for (let j = 0; j < shCoeffs; j++) {
                    sh[j * 3] = codebook[centroids[o + j * 4 + 0]];
                    sh[j * 3 + 1] = codebook[centroids[o + j * 4 + 1]];
                    sh[j * 3 + 2] = codebook[centroids[o + j * 4 + 2]];
                }
                setShFn(offset + i, sh);
            }
        }
    }

    private async loadTexture(path: string) {
        let buffer: Uint8Array | undefined = this.refs[path];
        if (!buffer) {
            if (isUrl(path)) {
                buffer = await fetch(path)
                    .then(res => res.arrayBuffer())
                    .then(buf => new Uint8Array(buf));
            }
        }
        if (!buffer) {
            throw new Error(`Cannot load texture: ${path}`);
        }

        const { data, width, height } = decodeWebP(buffer);
        return {
            data: new Uint8Array(data),
            width,
            height,
        };
    }

    async read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData) {
        await this.load(stream, contentLength);
        const BlockOffset = await data.initBlock(this.counts, this.shDegree);

        const { means, scales, quats, sh0, shN } = this.meta;
        this.cached = await Promise.all(
            [
                means.files[0],
                means.files[1],
                scales.files[0],
                quats.files[0],
                sh0.files[0],
                shN?.files[0],
                shN?.files[1],
            ]
                .filter(path => !!path)
                .map(path => this.loadTexture(path!)),
        );

        if (this.version === 1) {
            this.parse_v1(data, BlockOffset);
        } else if (this.version === 2) {
            this.parse_v2(data, BlockOffset);
        } else {
            throw new Error(`Unsupported SOG version: ${this.version}`);
        }
        data.finishBlock();
    }

    async write(stream: WritableStream<Uint8Array>, data: SplatData, indices: Uint32Array) {
        const { counts, shDegree, shCounts, table } = data;
        const width = Math.ceil(Math.sqrt(counts) / 4) * 4;
        const height = Math.ceil(counts / width / 4) * 4;
        const channels = 4;
        const single = createSingleSplat(shCounts);
        const webPProfile = new WebPLosslessProfile();
        const output: Zippable = {};
        const meta: SogMetadataV2 = {
            version: 2,
            count: counts,
            means: {
                mins: [],
                maxs: [],
                files: ['means_l.webp', 'means_u.webp'],
            },
            scales: {
                codebook: [],
                files: ['scales.webp'],
            },
            quats: {
                files: ['quats.webp'],
            },
            sh0: {
                codebook: [],
                files: ['sh0.webp'],
            },
        };

        // means
        {
            logger.time('SOG encoding means');
            const xCol = table[ColIdx.x];
            const yCol = table[ColIdx.y];
            const zCol = table[ColIdx.z];

            // calculate minmax & transform
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                const x = xCol[idx];
                const y = yCol[idx];
                const z = zCol[idx];
                if (x < minX) {
                    minX = x;
                }
                if (x > maxX) {
                    maxX = x;
                }
                if (y < minY) {
                    minY = y;
                }
                if (y > maxY) {
                    maxY = y;
                }
                if (z < minZ) {
                    minZ = z;
                }
                if (z > maxZ) {
                    maxZ = z;
                }
            }
            minX = logTransform(minX);
            minY = logTransform(minY);
            minZ = logTransform(minZ);
            maxX = logTransform(maxX);
            maxY = logTransform(maxY);
            maxZ = logTransform(maxZ);
            const scaleX = 65535 / Math.max(maxX - minX, 1e-9);
            const scaleY = 65535 / Math.max(maxY - minY, 1e-9);
            const scaleZ = 65535 / Math.max(maxZ - minZ, 1e-9);

            // encode means
            const meansL = new Uint8Array(width * height * channels).fill(0xff);
            const meansU = new Uint8Array(width * height * channels).fill(0xff);
            for (let i = 0; i < indices.length; i++) {
                const idx = indices[i];
                const x = (logTransform(xCol[idx]) - minX) * scaleX;
                const y = (logTransform(yCol[idx]) - minY) * scaleY;
                const z = (logTransform(zCol[idx]) - minZ) * scaleZ;
                meansL[i * 4 + 0] = x & 0xff;
                meansL[i * 4 + 1] = y & 0xff;
                meansL[i * 4 + 2] = z & 0xff;
                meansU[i * 4 + 0] = (x >> 8) & 0xff;
                meansU[i * 4 + 1] = (y >> 8) & 0xff;
                meansU[i * 4 + 2] = (z >> 8) & 0xff;
            }

            output['means_l.webp'] = encodeWebP(meansL, width, height, webPProfile);
            output['means_u.webp'] = encodeWebP(meansU, width, height, webPProfile);
            meta.means.mins = [minX, minY, minZ];
            meta.means.maxs = [maxX, maxY, maxZ];
            logger.timeEnd('SOG encoding means');
        }

        // quaternions
        {
            logger.time('SOG encoding quaternions');
            const quats = new Uint8Array(width * height * channels);
            const q = [0, 0, 0, 0];
            for (let i = 0; i < indices.length; ++i) {
                data.getQuat(indices[i], single);
                q[0] = single.qw;
                q[1] = single.qx;
                q[2] = single.qy;
                q[3] = single.qz;
                const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);

                // normalize
                q.forEach((v, j) => {
                    q[j] = v / l;
                });

                // find max component
                const maxComp = q.reduce((v, _, i) => (Math.abs(q[i]) > Math.abs(q[v]) ? i : v), 0);
                // invert if max component is negative
                if (q[maxComp] < 0) {
                    q.forEach((_, j) => {
                        q[j] *= -1;
                    });
                }

                // scale by sqrt(2) to fit in [-1, 1] range
                q.forEach((_, j) => (q[j] *= Math.SQRT2));

                const idx = [
                    [1, 2, 3],
                    [0, 2, 3],
                    [0, 1, 3],
                    [0, 1, 2],
                ][maxComp];
                quats[i * 4] = (q[idx[0]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 1] = (q[idx[1]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 2] = (q[idx[2]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 3] = 252 + maxComp;
            }

            output['quats.webp'] = encodeWebP(quats, width, height, webPProfile);
            logger.timeEnd('SOG encoding quaternions');
        }

        // scales
        {
            logger.time('SOG encoding scales');
            const scaleData = quantize1d(
                [table[ColIdx.sx], table[ColIdx.sy], table[ColIdx.sz]],
                undefined,
                undefined,
                Math.log,
            );
            const tableData = writeTableData(scaleData.labels, indices, width, height, channels);
            output['scales.webp'] = encodeWebP(tableData, width, height, webPProfile);
            meta.scales.codebook = Array.from(scaleData.centroids);
            logger.timeEnd('SOG encoding scales');
        }

        // colors
        {
            logger.time('SOG encoding colors');
            const colorData = quantize1d(
                [table[ColIdx.r], table[ColIdx.g], table[ColIdx.b]],
                undefined,
                undefined,
                v => (v - 0.5) / SH_C0,
            );
            const aCol = table[ColIdx.a];
            const opacityData = new Uint8Array(aCol.length);
            for (let i = 0; i < counts; ++i) {
                opacityData[i] = clamp(aCol[i] * 255, 0, 255);
            }
            colorData.labels.push(opacityData);
            const tableData = writeTableData(colorData.labels, indices, width, height, channels);
            output['sh0.webp'] = encodeWebP(tableData, width, height, webPProfile);
            meta.sh0.codebook = Array.from(colorData.centroids);
            logger.timeEnd('SOG encoding colors');
        }

        // SH
        if (shDegree > 0) {
            logger.time(`SOG encoding SH${shDegree}`);
            const shCoeffs = shCounts / 3;
            const shDataTable: Float32Array[] = [];
            for (const i of buildSHTableMap(shCoeffs)) {
                shDataTable.push(table[ColIdx.shOffset + i]);
            }
            const paletteSize = Math.min(64, 2 ** Math.floor(Math.log2(indices.length / 1024))) * 1024;
            const device = await getOrCreateDevice();

            logger.info(`SOG SH${shDegree} k-means with clusters=${paletteSize} iterations=${this.iterations}`);
            logger.time(`SOG SH${shDegree} k-means`);
            const { centroids, labels } = await kMeans(shDataTable, paletteSize, this.iterations, device);
            logger.timeEnd(`SOG SH${shDegree} k-means`);

            const codebook = quantize1d(centroids);
            // write centroids
            const centroidsBuf = new Uint8Array(64 * shCoeffs * Math.ceil(centroids[0].length / 64) * channels).fill(
                0xff,
            );
            const centroidsRow: number[] = [];
            for (let i = 0; i < centroids[0].length; ++i) {
                codebook.labels.forEach((column, index) => {
                    centroidsRow[index] = column[i];
                });
                for (let j = 0; j < shCoeffs; ++j) {
                    centroidsBuf[i * shCoeffs * 4 + j * 4 + 0] = centroidsRow[shCoeffs * 0 + j];
                    centroidsBuf[i * shCoeffs * 4 + j * 4 + 1] = centroidsRow[shCoeffs * 1 + j];
                    centroidsBuf[i * shCoeffs * 4 + j * 4 + 2] = centroidsRow[shCoeffs * 2 + j];
                }
            }
            output['shN_centroids.webp'] = encodeWebP(
                centroidsBuf,
                64 * shCoeffs,
                Math.ceil(centroids[0].length / 64),
                webPProfile,
            );

            // write labels
            const labelsBuf = new Uint8Array(width * height * channels).fill(0xff);
            for (let i = 0; i < indices.length; ++i) {
                const label = labels[indices[i]];
                labelsBuf[i * 4 + 0] = label & 0xff;
                labelsBuf[i * 4 + 1] = (label >> 8) & 0xff;
            }
            output['shN_labels.webp'] = encodeWebP(labelsBuf, width, height, webPProfile);
            meta.shN = {
                count: paletteSize,
                bands: shDegree,
                codebook: Array.from(codebook.centroids),
                files: ['shN_centroids.webp', 'shN_labels.webp'],
            };
            logger.timeEnd(`SOG encoding SH${shDegree}`);
        }
        output['meta.json'] = Buffer.from(JSON.stringify(meta), 'utf-8');
        const result = zipSync(output);
        await stream.getWriter().write(result);
    }
}
