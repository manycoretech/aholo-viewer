import { unzipSync } from 'fflate';
import { PlyFile, SpzFile, KsplatFile, SplatFile, SogFile, LccFile } from '../file/index.js';
import { SplatData } from '../SplatData.js';
import { SH_MAPS } from '../constant.js';
export var SplatFileType;
(function (SplatFileType) {
    SplatFileType[SplatFileType["PLY"] = 0] = "PLY";
    SplatFileType[SplatFileType["SPZ"] = 1] = "SPZ";
    SplatFileType[SplatFileType["USPZ"] = 2] = "USPZ";
    SplatFileType[SplatFileType["SPLAT"] = 3] = "SPLAT";
    SplatFileType[SplatFileType["KSPLAT"] = 4] = "KSPLAT";
    SplatFileType[SplatFileType["SOG"] = 5] = "SOG";
    SplatFileType[SplatFileType["LCC"] = 6] = "LCC";
})(SplatFileType || (SplatFileType = {}));
export function detectSplatFileType(filename, buffer = new Uint8Array()) {
    let ext = filename.split('.').pop();
    if (ext === 'zip') {
        unzipSync(buffer, {
            filter: file => {
                const { name } = file;
                if (name.endsWith('meta.json')) {
                    ext = 'sog';
                }
                else if (name.endsWith('meta.lcc')) {
                    ext = 'lcc';
                }
                return false;
            },
        });
    }
    else if (ext === 'json') {
        // fast check sog json
        const json = JSON.parse(new TextDecoder().decode(buffer));
        const isSogMetadata = ['means', 'scales', 'quats', 'sh0'].every(k => !!json[k]);
        if (isSogMetadata) {
            ext = 'sog';
        }
    }
    let type;
    switch (ext) {
        case 'ply': {
            type = SplatFileType.PLY;
            break;
        }
        case 'spz': {
            type = SplatFileType.SPZ;
            break;
        }
        case 'uspz': {
            type = SplatFileType.USPZ;
            break;
        }
        case 'splat': {
            type = SplatFileType.SPLAT;
            break;
        }
        case 'ksplat': {
            type = SplatFileType.KSPLAT;
            break;
        }
        case 'sog': {
            type = SplatFileType.SOG;
            break;
        }
        case 'lcc': {
            type = SplatFileType.LCC;
            break;
        }
        default: {
            break;
        }
    }
    return type;
}
export function createSplatFile(path, buffer = new Uint8Array(), compressLevel = 6) {
    const type = detectSplatFileType(path, buffer);
    if (type === undefined) {
        throw new Error(`Unsupported file format: ${path}`);
    }
    let file;
    switch (type) {
        case SplatFileType.PLY: {
            file = new PlyFile();
            break;
        }
        case SplatFileType.SPZ: {
            file = new SpzFile(compressLevel);
            break;
        }
        case SplatFileType.USPZ: {
            file = new SpzFile(-1);
            break;
        }
        case SplatFileType.KSPLAT: {
            file = new KsplatFile();
            break;
        }
        case SplatFileType.SPLAT: {
            file = new SplatFile();
            break;
        }
        case SplatFileType.SOG: {
            file = new SogFile();
            break;
        }
        case SplatFileType.LCC: {
            file = new LccFile();
            break;
        }
    }
    return file;
}
export function combineSplatData(source) {
    const target = new SplatData().init(source.reduce((p, c) => p + c.counts, 0), Math.max(...source.map(v => v.shDegree)));
    const single = {
        x: 0, y: 0, z: 0,
        sx: 0, sy: 0, sz: 0,
        qx: 0, qy: 0, qz: 0, qw: 0,
        r: 0, g: 0, b: 0, a: 0,
        shN: new Array(SH_MAPS[target.shDegree]),
    };
    const shN = single.shN;
    let index = 0;
    for (let i = 0; i < source.length; i++) {
        const splat = source[i];
        const { counts } = splat;
        for (let j = 0; j < counts; j++) {
            splat.get(j, single);
            splat.getShN(j, shN);
            target.set(index, single);
            target.setShN(index, shN);
            index++;
        }
    }
    return target;
}
const VOXEL_COUNTS = 65535;
export function computeDenseBox(data, ratio = 0.98) {
    if (data.counts === 0) {
        return { min: [0, 0, 0], max: [0, 0, 0] };
    }
    const xCol = data.table[0 /* ColIdx.x */];
    const yCol = data.table[1 /* ColIdx.y */];
    const zCol = data.table[2 /* ColIdx.z */];
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < data.counts; i++) {
        const x = xCol[i];
        const y = yCol[i];
        const z = zCol[i];
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
    const scaleX = VOXEL_COUNTS / Math.max(maxX - minX, 1e-9);
    const scaleY = VOXEL_COUNTS / Math.max(maxY - minY, 1e-9);
    const scaleZ = VOXEL_COUNTS / Math.max(maxZ - minZ, 1e-9);
    const xChunks = new Uint32Array(VOXEL_COUNTS);
    const yChunks = new Uint32Array(VOXEL_COUNTS);
    const zChunks = new Uint32Array(VOXEL_COUNTS);
    for (let i = 0; i < data.counts; i++) {
        xChunks[((xCol[i] - minX) * scaleX) | 0]++;
        yChunks[((yCol[i] - minY) * scaleY) | 0]++;
        zChunks[((zCol[i] - minZ) * scaleZ) | 0]++;
    }
    const K = Math.ceil(data.counts * (1 - ratio));
    let startX = 0;
    let endX = VOXEL_COUNTS - 1;
    let startY = 0;
    let endY = VOXEL_COUNTS - 1;
    let startZ = 0;
    let endZ = VOXEL_COUNTS - 1;
    let count = data.counts;
    while (count > K) {
        const xs = xChunks[startX];
        const xe = xChunks[endX];
        const ys = yChunks[startY];
        const ye = yChunks[endY];
        const zs = zChunks[startZ];
        const ze = zChunks[endZ];
        let min = xs;
        let minKey = 'startX';
        if (xe < min) {
            min = xe;
            minKey = 'endX';
        }
        if (ys < min) {
            min = ys;
            minKey = 'startY';
        }
        if (ye < min) {
            min = ye;
            minKey = 'endY';
        }
        if (zs < min) {
            min = zs;
            minKey = 'startZ';
        }
        if (ze < min) {
            min = ze;
            minKey = 'endZ';
        }
        switch (minKey) {
            case 'startX':
                startX++;
                break;
            case 'endX':
                endX--;
                break;
            case 'startY':
                startY++;
                break;
            case 'endY':
                endY--;
                break;
            case 'startZ':
                startZ++;
                break;
            case 'endZ':
                endZ--;
                break;
        }
        count -= min;
    }
    return {
        min: [(startX / scaleX) + minX, (startY / scaleY) + minY, (startZ / scaleZ) + minZ],
        max: [(endX / scaleX) + minX, (endY / scaleY) + minY, (endZ / scaleZ) + minZ],
    };
}
// https://github.com/playcanvas/splat-transform/blob/main/src/lib/data-table/data-table.ts
export function mortonSort(splat) {
    const result = new Uint32Array(splat.counts);
    const xCol = splat.table[0 /* ColIdx.x */];
    const yCol = splat.table[1 /* ColIdx.y */];
    const zCol = splat.table[2 /* ColIdx.z */];
    for (let i = 0; i < result.length; ++i) {
        result[i] = i;
    }
    const generate = (indices) => {
        if (indices.length === 0) {
            return;
        }
        // https://fgiesen.wordpress.com/2009/12/13/decoding-morton-codes/
        const encodeMorton3 = (x, y, z) => {
            const Part1By2 = (x) => {
                x &= 0x000003ff;
                x = (x ^ (x << 16)) & 0xff0000ff;
                x = (x ^ (x << 8)) & 0x0300f00f;
                x = (x ^ (x << 4)) & 0x030c30c3;
                x = (x ^ (x << 2)) & 0x09249249;
                return x;
            };
            return (Part1By2(z) << 2) + (Part1By2(y) << 1) + Part1By2(x);
        };
        let mx = Infinity;
        let my = Infinity;
        let mz = Infinity;
        let Mx = -Infinity;
        let My = -Infinity;
        let Mz = -Infinity;
        // calculate scene extents across all splats (using sort centers, because they're in world space)
        for (let i = 0; i < indices.length; ++i) {
            const ri = indices[i];
            const x = xCol[ri];
            const y = yCol[ri];
            const z = zCol[ri];
            if (x < mx) {
                mx = x;
            }
            if (x > Mx) {
                Mx = x;
            }
            if (y < my) {
                my = y;
            }
            if (y > My) {
                My = y;
            }
            if (z < mz) {
                mz = z;
            }
            if (z > Mz) {
                Mz = z;
            }
        }
        const xlen = Mx - mx;
        const ylen = My - my;
        const zlen = Mz - mz;
        if (!isFinite(xlen) || !isFinite(ylen) || !isFinite(zlen)) {
            console.debug('invalid extents', xlen, ylen, zlen);
            return;
        }
        // all points are identical
        if (xlen === 0 && ylen === 0 && zlen === 0) {
            return;
        }
        const xmul = (xlen === 0) ? 0 : 1024 / xlen;
        const ymul = (ylen === 0) ? 0 : 1024 / ylen;
        const zmul = (zlen === 0) ? 0 : 1024 / zlen;
        const morton = new Uint32Array(indices.length);
        for (let i = 0; i < indices.length; ++i) {
            const ri = indices[i];
            const x = xCol[ri];
            const y = yCol[ri];
            const z = zCol[ri];
            const ix = Math.min(1023, (x - mx) * xmul) >>> 0;
            const iy = Math.min(1023, (y - my) * ymul) >>> 0;
            const iz = Math.min(1023, (z - mz) * zmul) >>> 0;
            morton[i] = encodeMorton3(ix, iy, iz);
        }
        // sort indices by morton code
        const order = new Uint32Array(indices.length);
        for (let i = 0; i < order.length; i++) {
            order[i] = i;
        }
        order.sort((a, b) => morton[a] - morton[b]);
        const tmpIndices = indices.slice();
        for (let i = 0; i < indices.length; ++i) {
            indices[i] = tmpIndices[order[i]];
        }
        // sort the largest buckets recursively
        let start = 0;
        let end = 1;
        while (start < indices.length) {
            while (end < indices.length && morton[order[end]] === morton[order[start]]) {
                ++end;
            }
            if (end - start > 256) {
                generate(indices.subarray(start, end));
            }
            start = end;
        }
    };
    generate(result);
    return result;
}
export function fastDeleteSplat(splat, indices) {
    const { counts, table } = splat;
    const map = new Uint32Array(counts - indices.length);
    let write = 0;
    let removeIdx = 0;
    for (let read = 0; read < counts; read++) {
        if (removeIdx < indices.length && read === indices[removeIdx]) {
            removeIdx++;
            continue;
        }
        map[write++] = read;
    }
    for (let i = 0; i < table.length; i++) {
        const col = table[i];
        for (let j = 0; j < map.length; j++) {
            col[j] = col[map[j]];
        }
    }
    splat.counts -= indices.length;
    for (let i = 0; i < table.length; i++) {
        table[i] = table[i].subarray(0, splat.counts);
    }
}
