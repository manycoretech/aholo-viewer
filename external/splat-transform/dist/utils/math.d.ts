export declare class Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
    static ONE: Quaternion;
    constructor(x: number, y: number, z: number, w: number);
    set(x: number, y: number, z: number, w: number): this;
    equals(q: Quaternion): boolean;
    normalize(): this;
    multiply(q: Quaternion): Quaternion;
    premultiply(q: Quaternion): Quaternion;
    multiplyQuaternions(a: Quaternion, b: Quaternion): this;
    setRotationMatrix(m: Matrix4): this;
}
export declare class Vector3 {
    x: number;
    y: number;
    z: number;
    static ONE: Vector3;
    constructor(x: number, y: number, z: number);
    set(x: number, y: number, z: number): this;
    length(): number;
    equals(v: Vector3): boolean;
    mul(v: Vector3): this;
    applyMatrix4(m: Matrix4): this;
    clone(): Vector3;
}
export declare class Matrix4 {
    static ONE: Matrix4;
    elements: Float32Array<ArrayBuffer>;
    constructor(elements?: number[], isRow?: boolean);
    set(elements: number[] | Float32Array): this;
    equals(matrix: Matrix4): boolean;
    determinant(): number;
    multiply(m: Matrix4): Matrix4;
    multiplyMatrices(a: Matrix4, b: Matrix4): Matrix4;
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): Matrix4;
    decompose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    transpose(): this;
}
export declare class Matrix3 {
    elements: Float32Array<ArrayBuffer>;
    set(n11: number, n12: number, n13: number, n21: number, n22: number, n23: number, n31: number, n32: number, n33: number): this;
    setFromMatrix4(m: Matrix4): this;
}
