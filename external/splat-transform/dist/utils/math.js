export class Quaternion {
    static { this.ONE = new Quaternion(0, 0, 0, 1); }
    constructor(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
    }
    set(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
        return this;
    }
    equals(q) {
        return (q.x === this.x) && (q.y === this.y) && (q.z === this.z) && (q.w === this.w);
    }
    normalize() {
        const length = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
        if (length === 0) {
            return this;
        }
        const invLength = (1 / length) * (this.w < 0 ? -1 : 1);
        this.x *= invLength;
        this.y *= invLength;
        this.z *= invLength;
        this.w *= invLength;
        return this;
    }
    multiply(q) {
        return this.multiplyQuaternions(this, q);
    }
    premultiply(q) {
        return this.multiplyQuaternions(q, this);
    }
    multiplyQuaternions(a, b) {
        // from http://www.euclideanspace.com/maths/algebra/realNormedAlgebra/quaternions/code/index.htm
        const qax = a.x;
        const qay = a.y;
        const qaz = a.z;
        const qaw = a.w;
        const qbx = b.x;
        const qby = b.y;
        const qbz = b.z;
        const qbw = b.w;
        this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
        this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
        this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
        this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
        return this;
    }
    setRotationMatrix(m) {
        // http://www.euclideanspace.com/maths/geometry/rotations/conversions/matrixToQuaternion/index.htm
        // assumes the upper 3x3 of m is a pure rotation matrix (i.e, unscaled)
        const te = m.elements;
        const m11 = te[0];
        const m12 = te[4];
        const m13 = te[8];
        const m21 = te[1];
        const m22 = te[5];
        const m23 = te[9];
        const m31 = te[2];
        const m32 = te[6];
        const m33 = te[10];
        const trace = m11 + m22 + m33;
        let s;
        if (trace > 0) {
            s = 0.5 / Math.sqrt(trace + 1.0);
            this.w = 0.25 / s;
            this.x = (m32 - m23) * s;
            this.y = (m13 - m31) * s;
            this.z = (m21 - m12) * s;
        }
        else if (m11 > m22 && m11 > m33) {
            s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
            this.w = (m32 - m23) / s;
            this.x = 0.25 * s;
            this.y = (m12 + m21) / s;
            this.z = (m13 + m31) / s;
        }
        else if (m22 > m33) {
            s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
            this.w = (m13 - m31) / s;
            this.x = (m12 + m21) / s;
            this.y = 0.25 * s;
            this.z = (m23 + m32) / s;
        }
        else {
            s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
            this.w = (m21 - m12) / s;
            this.x = (m13 + m31) / s;
            this.y = (m23 + m32) / s;
            this.z = 0.25 * s;
        }
        return this;
    }
}
export class Vector3 {
    static { this.ONE = new Vector3(1, 1, 1); }
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }
    length() {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }
    equals(v) {
        return (v.x === this.x) && (v.y === this.y) && (v.z === this.z);
    }
    mul(v) {
        this.x *= v.x;
        this.y *= v.y;
        this.z *= v.z;
        return this;
    }
    applyMatrix4(m) {
        const { x, y, z } = this;
        const e = m.elements;
        const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
        this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
        this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
        return this;
    }
    clone() {
        return new Vector3(this.x, this.y, this.z);
    }
}
export class Matrix4 {
    static { this.ONE = new Matrix4(); }
    constructor(elements, isRow = false) {
        this.elements = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        if (elements) {
            this.set(elements);
        }
        if (isRow) {
            this.transpose();
        }
    }
    set(elements) {
        for (let i = 0; i < 16; i++) {
            this.elements[i] = elements[i];
        }
        return this;
    }
    equals(matrix) {
        const te = this.elements;
        const me = matrix.elements;
        for (let i = 0; i < 16; i++) {
            if (te[i] !== me[i]) {
                return false;
            }
        }
        return true;
    }
    determinant() {
        const te = this.elements;
        const n11 = te[0], n12 = te[4], n13 = te[8], n14 = te[12], n21 = te[1], n22 = te[5], n23 = te[9], n24 = te[13], n31 = te[2], n32 = te[6], n33 = te[10], n34 = te[14], n41 = te[3], n42 = te[7], n43 = te[11], n44 = te[15];
        // based on http://www.euclideanspace.com/maths/algebra/matrix/functions/inverse/fourD/index.htm
        return (n41 * (+n14 * n23 * n32
            - n13 * n24 * n32
            - n14 * n22 * n33
            + n12 * n24 * n33
            + n13 * n22 * n34
            - n12 * n23 * n34) +
            n42 * (+n11 * n23 * n34
                - n11 * n24 * n33
                + n14 * n21 * n33
                - n13 * n21 * n34
                + n13 * n24 * n31
                - n14 * n23 * n31) +
            n43 * (+n11 * n24 * n32
                - n11 * n22 * n34
                - n14 * n21 * n32
                + n12 * n21 * n34
                + n14 * n22 * n31
                - n12 * n24 * n31) +
            n44 * (-n13 * n22 * n31
                - n11 * n23 * n32
                + n11 * n22 * n33
                + n13 * n21 * n32
                - n12 * n21 * n33
                + n12 * n23 * n31));
    }
    multiply(m) {
        return this.multiplyMatrices(this, m);
    }
    multiplyMatrices(a, b) {
        const te = this.elements;
        const ae = a.elements;
        const be = b.elements;
        const a11 = ae[0];
        const a12 = ae[4];
        const a13 = ae[8];
        const a14 = ae[12];
        const a21 = ae[1];
        const a22 = ae[5];
        const a23 = ae[9];
        const a24 = ae[13];
        const a31 = ae[2];
        const a32 = ae[6];
        const a33 = ae[10];
        const a34 = ae[14];
        const a41 = ae[3];
        const a42 = ae[7];
        const a43 = ae[11];
        const a44 = ae[15];
        const b11 = be[0];
        const b12 = be[4];
        const b13 = be[8];
        const b14 = be[12];
        const b21 = be[1];
        const b22 = be[5];
        const b23 = be[9];
        const b24 = be[13];
        const b31 = be[2];
        const b32 = be[6];
        const b33 = be[10];
        const b34 = be[14];
        const b41 = be[3];
        const b42 = be[7];
        const b43 = be[11];
        const b44 = be[15];
        te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
        te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
        te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
        te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
        te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
        te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
        te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
        te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
        te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
        te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
        te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
        te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
        te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
        te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
        te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
        te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
        return this;
    }
    compose(position, quaternion, scale) {
        const te = this.elements;
        const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2, sx = scale.x, sy = scale.y, sz = scale.z;
        te[0] = (1 - (yy + zz)) * sx;
        te[1] = (xy + wz) * sx;
        te[2] = (xz - wy) * sx;
        te[3] = 0;
        te[4] = (xy - wz) * sy;
        te[5] = (1 - (xx + zz)) * sy;
        te[6] = (yz + wx) * sy;
        te[7] = 0;
        te[8] = (xz + wy) * sz;
        te[9] = (yz - wx) * sz;
        te[10] = (1 - (xx + yy)) * sz;
        te[11] = 0;
        te[12] = position.x;
        te[13] = position.y;
        te[14] = position.z;
        te[15] = 1;
        return this;
    }
    decompose(position, quaternion, scale) {
        const te = this.elements;
        let sx = tmpVec.set(te[0], te[1], te[2]).length();
        const sy = tmpVec.set(te[4], te[5], te[6]).length();
        const sz = tmpVec.set(te[8], te[9], te[10]).length();
        const det = this.determinant();
        if (det < 0) {
            sx *= -1;
        }
        position.set(te[12], te[13], te[14]);
        const invSX = 1 / sx;
        const invSY = 1 / sy;
        const invSZ = 1 / sz;
        tmpMat4.set(this.elements);
        tmpMat4.elements[0] *= invSX;
        tmpMat4.elements[1] *= invSX;
        tmpMat4.elements[2] *= invSX;
        tmpMat4.elements[4] *= invSY;
        tmpMat4.elements[5] *= invSY;
        tmpMat4.elements[6] *= invSY;
        tmpMat4.elements[8] *= invSZ;
        tmpMat4.elements[9] *= invSZ;
        tmpMat4.elements[10] *= invSZ;
        quaternion.setRotationMatrix(tmpMat4);
        scale.set(sx, sy, sz);
        return this;
    }
    transpose() {
        const te = this.elements;
        let tmp;
        tmp = te[1];
        te[1] = te[4];
        te[4] = tmp;
        tmp = te[2];
        te[2] = te[8];
        te[8] = tmp;
        tmp = te[6];
        te[6] = te[9];
        te[9] = tmp;
        tmp = te[3];
        te[3] = te[12];
        te[12] = tmp;
        tmp = te[7];
        te[7] = te[13];
        te[13] = tmp;
        tmp = te[11];
        te[11] = te[14];
        te[14] = tmp;
        return this;
    }
}
export class Matrix3 {
    constructor() {
        this.elements = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    set(n11, n12, n13, n21, n22, n23, n31, n32, n33) {
        const te = this.elements;
        te[0] = n11;
        te[1] = n21;
        te[2] = n31;
        te[3] = n12;
        te[4] = n22;
        te[5] = n32;
        te[6] = n13;
        te[7] = n23;
        te[8] = n33;
        return this;
    }
    setFromMatrix4(m) {
        const me = m.elements;
        this.set(me[0], me[4], me[8], me[1], me[5], me[9], me[2], me[6], me[10]);
        return this;
    }
}
const tmpVec = new Vector3(0, 0, 0);
const tmpMat4 = new Matrix4();
