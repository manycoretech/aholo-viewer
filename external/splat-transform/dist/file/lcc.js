import { unzipSync } from 'fflate';
import { extractFromRootDir } from '../utils/index.js';
const ZIP_MAGIC = 0x04034b50;
const SQRT_2 = 1.414213562373095;
const SQRT_2_INV = 0.7071067811865475;
function decodeRotation(v) {
    const d0 = (v & 1023) / 1023.0;
    const d1 = ((v >> 10) & 1023) / 1023.0;
    const d2 = ((v >> 20) & 1023) / 1023.0;
    const d3 = (v >> 30) & 3;
    const qx = d0 * SQRT_2 - SQRT_2_INV;
    const qy = d1 * SQRT_2 - SQRT_2_INV;
    const qz = d2 * SQRT_2 - SQRT_2_INV;
    let sum = qx * qx + qy * qy + qz * qz;
    sum = Math.min(1.0, sum);
    const qw = Math.sqrt(1 - sum);
    if (d3 === 0) {
        return [qw, qx, qy, qz];
    }
    else if (d3 === 1) {
        return [qx, qw, qy, qz];
    }
    else if (d3 === 2) {
        return [qx, qy, qw, qz];
    }
    return [qx, qy, qz, qw];
}
;
function DecodePacked_11_10_11(enc) {
    return [
        (enc & 0x7FF) / 2047.0,
        ((enc >> 11) & 0x3FF) / 1023.0,
        ((enc >> 21) & 0x7FF) / 2047.0,
    ];
}
;
function mix(min, max, s) {
    return (1.0 - s) * min + s * max;
}
;
export class LccFile {
    counts = 0;
    shDegree = 0;
    meta;
    refs = {};
    load(buffer) {
        const view = new DataView(buffer.buffer);
        if (view.getUint32(0, true) !== ZIP_MAGIC) {
            throw new Error('LCC file is not a valid zip archive.');
        }
        this.refs = extractFromRootDir(unzipSync(buffer));
        if (!['meta.lcc', 'index.bin', 'data.bin'].every(name => !!this.refs[name])) {
            throw new Error('LCC file is missing required files.');
        }
        this.meta = JSON.parse(new TextDecoder().decode(this.refs['meta.lcc']));
        this.counts = this.meta.splats[0];
        this.shDegree = !!this.refs['shcoef.bin'] ? 3 : 0;
    }
    async read(stream, contentLength, data) {
        let BlockOffset = 0;
        {
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
            this.load(buffer);
            BlockOffset = await data.initBlock(this.counts, this.shDegree);
        }
        const setFn = data.set.bind(data);
        const setShFn = data.setShN.bind(data);
        const { meta, refs } = this;
        const infos = [];
        {
            const index = new DataView(refs['index.bin'].buffer);
            const infoCounts = Math.floor(index.byteLength / (4 + 16 * meta.totalLevel));
            let offset = 0;
            for (let i = 0; i < infoCounts; i++) {
                const x = index.getInt16(offset, true);
                offset += 2;
                const y = index.getInt16(offset, true);
                offset += 2;
                const lods = [];
                for (let j = 0; j < meta.totalLevel; j++) {
                    const points = index.getInt32(offset, true);
                    offset += 4;
                    const ldOffset = Number(index.getBigInt64(offset, true));
                    offset += 8;
                    const size = index.getInt32(offset, true);
                    offset += 4;
                    lods.push({ points, offset: ldOffset, size });
                }
                infos.push({ x, y, lods });
            }
        }
        const attributes = meta.attributes.reduce((p, c) => {
            p[c.name] = c;
            return p;
        }, {});
        const { scale: { min: scaleMin, max: scaleMax }, shcoef: { min: shMin, max: shMax } } = attributes;
        const single = {
            x: 0, y: 0, z: 0,
            sx: 0, sy: 0, sz: 0,
            qx: 0, qy: 0, qz: 0, qw: 0,
            r: 0, g: 0, b: 0, a: 0,
            shN: [],
        };
        const shData = new Array(45);
        let index = BlockOffset;
        for (let i = 0; i < infos.length; i++) {
            const info = infos[i];
            const { points, offset, size } = info.lods[0];
            const dataview = new DataView(refs['data.bin'].buffer, offset, size);
            const shN = refs['shcoef.bin'] ? new DataView(refs['shcoef.bin'].buffer, offset * 2, size * 2) : undefined;
            for (let j = 0; j < points; j++) {
                const off = j * 32;
                single.x = dataview.getFloat32(off + 0, true);
                single.y = dataview.getFloat32(off + 4, true);
                single.z = dataview.getFloat32(off + 8, true);
                single.r = dataview.getUint8(off + 12) / 255.0;
                single.g = dataview.getUint8(off + 13) / 255.0;
                single.b = dataview.getUint8(off + 14) / 255.0;
                single.a = dataview.getUint8(off + 15) / 255.0;
                single.sx = mix(scaleMin[0], scaleMax[0], dataview.getUint16(off + 16, true) / 65535.0);
                single.sy = mix(scaleMin[1], scaleMax[1], dataview.getUint16(off + 18, true) / 65535.0);
                single.sz = mix(scaleMin[2], scaleMax[2], dataview.getUint16(off + 20, true) / 65535.0);
                const quat = decodeRotation(dataview.getUint32(off + 22, true));
                single.qx = quat[0];
                single.qy = quat[1];
                single.qz = quat[2];
                single.qw = quat[3];
                setFn(index, single);
                if (shN) {
                    const shOff = off * 2;
                    for (let k = 0; k < 15; k++) {
                        const v = DecodePacked_11_10_11(shN.getUint32(shOff + k * 4, true));
                        shData[k * 3] = mix(shMin[0], shMax[0], v[0]);
                        shData[k * 3 + 1] = mix(shMin[1], shMax[1], v[1]);
                        shData[k * 3 + 2] = mix(shMin[2], shMax[2], v[2]);
                    }
                    setShFn(index, shData);
                }
                index++;
            }
        }
        data.finishBlock();
    }
    async write(_stream, _data) {
        throw new Error('Method not implemented.');
    }
}
