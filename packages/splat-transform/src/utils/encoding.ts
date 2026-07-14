import { Quaternion, Vector3 } from './math.js';

export function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
}

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
export function toHalf(f: number): number {
    f32buffer[0] = f;
    const bits = u32buffer[0];

    const sign = (bits >> 31) & 0x1;
    const exp = (bits >> 23) & 0xff;
    const frac = bits & 0x7fffff;
    const halfSign = sign << 15;

    if (exp === 0xff) {
        return halfSign | (frac === 0 ? 0x7c00 : 0x7fff);
    }

    const newExp = exp - 127 + 15;
    if (newExp >= 0x1f) {
        return halfSign | 0x7c00;
    }
    if (newExp <= 0) {
        if (newExp < -10) {
            return halfSign;
        }
        const subFrac = (frac | 0x800000) >> (1 - newExp + 13);
        return halfSign | subFrac;
    }

    return halfSign | (newExp << 10) | (frac >> 13);
}

export function fromHalf(h: number): number {
    const sign = (h >> 15) & 0x1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;

    let f32bits: number;
    if (exp === 0) {
        if (frac === 0) {
            f32bits = sign << 31;
        } else {
            let mant = frac;
            let e = -14;
            while ((mant & 0x400) === 0) {
                mant <<= 1;
                e--;
            }
            mant &= 0x3ff;
            const newExp = e + 127;
            const newFrac = mant << 13;
            f32bits = (sign << 31) | (newExp << 23) | newFrac;
        }
    } else if (exp === 0x1f) {
        if (frac === 0) {
            f32bits = (sign << 31) | 0x7f800000;
        } else {
            f32bits = (sign << 31) | 0x7fc00000;
        }
    } else {
        const newExp = exp - 15 + 127;
        const newFrac = frac << 13;
        f32bits = (sign << 31) | (newExp << 23) | newFrac;
    }

    u32buffer[0] = f32bits;
    return f32buffer[0];
}

export function encode111011s(a: number, b: number, c: number) {
    return (
        ((clamp(((a * 0.5 + 0.5) * 2047) | 0, 0, 2047) << 21) |
            (clamp(((b * 0.5 + 0.5) * 1023) | 0, 0, 1023) << 11) |
            clamp(((c * 0.5 + 0.5) * 2047) | 0, 0, 2047)) >>>
        0
    );
}

export function decode111011s(value: number, out: number[], offset: number) {
    out[offset + 0] = (((value >>> 21) & 2047) / 2047) * 2 - 1;
    out[offset + 1] = (((value >>> 11) & 1023) / 1023) * 2 - 1;
    out[offset + 2] = ((value & 2047) / 2047) * 2 - 1;
}

const tempArr = new Array(4);
const tempVec = new Vector3(0, 0, 0);
const tempQuat = new Quaternion(0, 0, 0, 1);
export function encodeQuatOct(x: number, y: number, z: number, w: number): number[] {
    const q = tempQuat.set(x, y, z, w);
    if (q.w < 0) {
        q.set(-q.x, -q.y, -q.z, -q.w);
    }
    const theta = 2 * Math.acos(q.w);
    const xyz_norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
    const axis = xyz_norm < 1e-6 ? tempVec.set(1, 0, 0) : tempVec.set(q.x, q.y, q.z).divideScalar(xyz_norm);

    const sum = Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z);
    let p_x = axis.x / sum;
    let p_y = axis.y / sum;
    if (axis.z < 0) {
        const tmp = p_x;
        p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
        p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
    }
    tempArr[0] = p_x;
    tempArr[1] = p_y;
    tempArr[2] = theta / Math.PI;
    return tempArr;
}

export function decodeQuatOct(u: number, v: number, angle: number): number[] {
    let f_x = u;
    let f_y = v;
    const f_z = 1 - (Math.abs(f_x) + Math.abs(f_y));
    const t = Math.max(-f_z, 0);
    f_x += f_x >= 0 ? -t : t;
    f_y += f_y >= 0 ? -t : t;
    const axis = tempVec.set(f_x, f_y, f_z).normalize();
    const theta = angle * Math.PI;
    const halfTheta = theta * 0.5;
    const s = Math.sin(halfTheta);
    tempArr[0] = axis.x * s;
    tempArr[1] = axis.y * s;
    tempArr[2] = axis.z * s;
    tempArr[3] = Math.cos(halfTheta);
    return tempArr;
}
