import { unzipSync, zipSync } from 'fflate';
import { clamp, extractFromRootDir, isUrl, logger, mortonSort } from '../utils/index.js';
import { decodeWebP, encodeWebP, WebPLosslessProfile } from '../native/index.js';
import { SH_C0, SH_MAPS } from '../constant.js';
const TEMP_ROT = new Array(4);
const PERM_TABLE = [
    [0, 1, 2, 3],
    [3, 1, 2, 0],
    [1, 3, 2, 0],
    [1, 2, 3, 0],
];
const COLOR_SCALE = SH_C0 / 0.15;
const SH_SCALE1 = 1 << 3;
const SH_SCALE2 = 1 << 4;
function logTransform(value) {
    return Math.sign(value) * Math.log(Math.abs(value) + 1);
}
;
export class EszFile {
    constructor() {
        this.counts = 0;
        this.shDegree = 0;
        /**
         * @internal
         */
        this.refs = {};
    }
    async load(stream, contentLength) {
        const buffer = new Uint8Array(contentLength);
        const reader = stream.getReader();
        let offset = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer.set(value, offset);
            offset += value.length;
        }
        this.refs = extractFromRootDir(unzipSync(buffer));
        const metaBuffer = this.refs['meta.json'];
        if (!metaBuffer) {
            throw new Error('SOG meta.json not found in the zip archive.');
        }
        const meta = this.meta = JSON.parse(new TextDecoder().decode(metaBuffer));
        this.version = meta.version;
        this.counts = meta.counts;
        this.shDegree = meta.shDegree;
    }
    async loadTexture(path) {
        let buffer = this.refs[path];
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
    async read(stream, contentLength, data) {
        await this.load(stream, contentLength);
        const offset = await data.initBlock(this.counts, this.shDegree);
        const { resources } = this.meta;
        this.cached = await Promise.all([
            resources.means_l, resources.means_u,
            resources.scales, resources.quats,
            resources.sh0, resources.shN,
        ].filter(path => !!path).map(path => this.loadTexture(path)));
        const setFn = data.set.bind(data);
        const setShFn = data.setShN.bind(data);
        const SCALE_LUT = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            SCALE_LUT[i] = Math.exp(i / 16 - 10);
        }
        const COLOR_LUT = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            COLOR_LUT[i] = (i / 255 - 0.5) * COLOR_SCALE + 0.5;
        }
        const { meta: { box }, counts, shDegree, cached } = this;
        const [means_l, means_u, scales, quats, color, shN] = cached.map(v => v.data);
        const { min: [centerMinX, centerMinY, centerMinZ], max: [centerMaxX, centerMaxY, centerMaxZ] } = box;
        const rangeX = (centerMaxX - centerMinX) / 65535;
        const rangeY = (centerMaxY - centerMinY) / 65535;
        const rangeZ = (centerMaxZ - centerMinZ) / 65535;
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        for (let i = 0; i < counts; i++) {
            const i4 = i * 4;
            const x = centerMinX + rangeX * (means_l[i4 + 0] + (means_u[i4 + 0] << 8));
            const y = centerMinY + rangeY * (means_l[i4 + 1] + (means_u[i4 + 1] << 8));
            const z = centerMinZ + rangeZ * (means_l[i4 + 2] + (means_u[i4 + 2] << 8));
            single.x = Math.sign(x) * (Math.exp(Math.abs(x)) - 1);
            single.y = Math.sign(y) * (Math.exp(Math.abs(y)) - 1);
            single.z = Math.sign(z) * (Math.exp(Math.abs(z)) - 1);
            single.sx = SCALE_LUT[scales[i4 + 0]];
            single.sy = SCALE_LUT[scales[i4 + 1]];
            single.sz = SCALE_LUT[scales[i4 + 2]];
            TEMP_ROT[0] = (quats[i4 + 0] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[1] = (quats[i4 + 1] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[2] = (quats[i4 + 2] / 255 - 0.5) * Math.SQRT2;
            TEMP_ROT[3] = Math.sqrt(Math.max(0, 1.0 - TEMP_ROT[0] * TEMP_ROT[0] - TEMP_ROT[1] * TEMP_ROT[1] - TEMP_ROT[2] * TEMP_ROT[2]));
            const PERM = PERM_TABLE[quats[i4 + 3] - 252];
            single.qx = TEMP_ROT[PERM[0]];
            single.qy = TEMP_ROT[PERM[1]];
            single.qz = TEMP_ROT[PERM[2]];
            single.qw = TEMP_ROT[PERM[3]];
            single.r = COLOR_LUT[color[i4 + 0]];
            single.g = COLOR_LUT[color[i4 + 1]];
            single.b = COLOR_LUT[color[i4 + 2]];
            single.a = color[i4 + 3] / 255;
            setFn(offset + i, single);
        }
        if (shN) {
            const shCounts = SH_MAPS[shDegree];
            const shCoeffs = shCounts / 3;
            const sh = new Array(shCounts);
            for (let i = 0; i < counts; i++) {
                const o = i * shCounts;
                for (let j = 0; j < shCoeffs; j++) {
                    sh[o + j * 3 + 0] = (shN[(i * shCoeffs + j) * 4 + 0] - 128) / 128;
                    sh[o + j * 3 + 1] = (shN[(i * shCoeffs + j) * 4 + 1] - 128) / 128;
                    sh[o + j * 3 + 2] = (shN[(i * shCoeffs + j) * 4 + 2] - 128) / 128;
                }
                setShFn(offset + i, sh);
            }
        }
        data.finishBlock();
    }
    async write(stream, data, indices = mortonSort(data)) {
        const { counts, shDegree, shCounts, table } = data;
        const width = Math.ceil(Math.sqrt(counts) / 4) * 4;
        const height = Math.ceil(counts / width / 4) * 4;
        const webPProfile = new WebPLosslessProfile();
        const output = {};
        const meta = {
            version: 1,
            counts,
            shDegree,
            box: {
                min: [Infinity, Infinity, Infinity],
                max: [-Infinity, -Infinity, -Infinity],
            },
            resources: {
                means_l: 'means_l.webp', means_u: 'means_u.webp',
                scales: 'scales.webp', quats: 'quats.webp', sh0: 'sh0.webp',
            },
        };
        const xCol = table[0 /* ColIdx.x */];
        const yCol = table[1 /* ColIdx.y */];
        const zCol = table[2 /* ColIdx.z */];
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
        meta.box.min = [minX, minY, minZ];
        meta.box.max = [maxX, maxY, maxZ];
        {
            logger.time('ESZ encoding means');
            minX = logTransform(minX);
            minY = logTransform(minY);
            minZ = logTransform(minZ);
            maxX = logTransform(maxX);
            maxY = logTransform(maxY);
            maxZ = logTransform(maxZ);
            const scaleX = 65535 / Math.max(maxX - minX, 1e-9);
            const scaleY = 65535 / Math.max(maxY - minY, 1e-9);
            const scaleZ = 65535 / Math.max(maxZ - minZ, 1e-9);
            const meansL = new Uint8Array(width * height * 4).fill(0xff);
            const meansU = new Uint8Array(width * height * 4).fill(0xff);
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
            logger.timeEnd('ESZ encoding means');
        }
        {
            logger.time('ESZ encoding scales');
            const sxCol = table[3 /* ColIdx.sx */];
            const syCol = table[4 /* ColIdx.sy */];
            const szCol = table[5 /* ColIdx.sz */];
            const scales = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                scales[i * 4 + 0] = clamp(Math.round((Math.log(sxCol[idx]) + 10) * 16), 0, 255);
                scales[i * 4 + 1] = clamp(Math.round((Math.log(syCol[idx]) + 10) * 16), 0, 255);
                scales[i * 4 + 2] = clamp(Math.round((Math.log(szCol[idx]) + 10) * 16), 0, 255);
            }
            output['scales.webp'] = encodeWebP(scales, width, height, webPProfile);
            logger.timeEnd('ESZ encoding scales');
        }
        {
            logger.time('ESZ encoding quats');
            const qxCol = table[6 /* ColIdx.qx */];
            const qyCol = table[7 /* ColIdx.qy */];
            const qzCol = table[8 /* ColIdx.qz */];
            const qwCol = table[9 /* ColIdx.qw */];
            const quats = new Uint8Array(width * height * 4);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                TEMP_ROT[0] = qwCol[idx];
                TEMP_ROT[1] = qxCol[idx];
                TEMP_ROT[2] = qyCol[idx];
                TEMP_ROT[3] = qzCol[idx];
                const l = Math.sqrt(TEMP_ROT[0] * TEMP_ROT[0] + TEMP_ROT[1] * TEMP_ROT[1] + TEMP_ROT[2] * TEMP_ROT[2] + TEMP_ROT[3] * TEMP_ROT[3]);
                TEMP_ROT.forEach((v, j) => {
                    TEMP_ROT[j] = v / l;
                });
                const maxComp = TEMP_ROT.reduce((v, _, i) => (Math.abs(TEMP_ROT[i]) > Math.abs(TEMP_ROT[v]) ? i : v), 0);
                if (TEMP_ROT[maxComp] < 0) {
                    TEMP_ROT.forEach((_, j) => {
                        TEMP_ROT[j] *= -1;
                    });
                }
                TEMP_ROT.forEach((_, j) => TEMP_ROT[j] *= Math.SQRT2);
                const PERM = [
                    [1, 2, 3],
                    [0, 2, 3],
                    [0, 1, 3],
                    [0, 1, 2]
                ][maxComp];
                quats[i * 4] = (TEMP_ROT[PERM[0]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 1] = (TEMP_ROT[PERM[1]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 2] = (TEMP_ROT[PERM[2]] * 0.5 + 0.5) * 255;
                quats[i * 4 + 3] = 252 + maxComp;
            }
            output['quats.webp'] = encodeWebP(quats, width, height, webPProfile);
            logger.timeEnd('ESZ encoding quats');
        }
        {
            logger.time('ESZ encoding sh0');
            const rCol = table[10 /* ColIdx.r */];
            const gCol = table[11 /* ColIdx.g */];
            const bCol = table[12 /* ColIdx.b */];
            const aCol = table[13 /* ColIdx.a */];
            const sh0 = new Uint8Array(width * height * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                sh0[i * 4 + 0] = clamp(Math.round(((rCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 1] = clamp(Math.round(((gCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 2] = clamp(Math.round(((bCol[idx] - 0.5) / COLOR_SCALE + 0.5) * 255), 0, 255);
                sh0[i * 4 + 3] = clamp(Math.round(aCol[idx] * 255), 0, 255);
            }
            output['sh0.webp'] = encodeWebP(sh0, width, height, webPProfile);
            logger.timeEnd('ESZ encoding sh0');
        }
        if (shDegree > 0) {
            logger.time('ESZ encoding shN');
            const shCoeffs = shCounts / 3;
            const pixels = counts * shCoeffs;
            const shNWidth = Math.ceil(Math.sqrt(pixels) / 4) * 4;
            const shNHeight = Math.ceil(pixels / shNWidth / 4) * 4;
            const shN = new Uint8Array(shNWidth * shNHeight * 4).fill(0xff);
            for (let i = 0; i < counts; i++) {
                const idx = indices[i];
                const o = i * shCoeffs;
                for (let j = 0; j < shCoeffs; j++) {
                    const scale = j < 3 ? SH_SCALE1 : SH_SCALE2;
                    shN[(o + j) * 4 + 0] = clamp(Math.floor((Math.round(table[14 /* ColIdx.shOffset */ + (j * 3 + 0)][idx] * 128) + 128 + scale / 2) / scale) * scale, 0, 255);
                    shN[(o + j) * 4 + 1] = clamp(Math.floor((Math.round(table[14 /* ColIdx.shOffset */ + (j * 3 + 1)][idx] * 128) + 128 + scale / 2) / scale) * scale, 0, 255);
                    shN[(o + j) * 4 + 2] = clamp(Math.floor((Math.round(table[14 /* ColIdx.shOffset */ + (j * 3 + 2)][idx] * 128) + 128 + scale / 2) / scale) * scale, 0, 255);
                }
            }
            output['shN.webp'] = encodeWebP(shN, shNWidth, shNHeight, webPProfile);
            meta.resources.shN = 'shN.webp';
            logger.timeEnd('ESZ encoding shN');
        }
        output['meta.json'] = Buffer.from(JSON.stringify(meta), 'utf-8');
        const result = zipSync(output);
        await stream.getWriter().write(result);
    }
}
