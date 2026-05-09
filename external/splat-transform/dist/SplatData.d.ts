export interface ISingleSplat {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    sz: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
    r: number;
    g: number;
    b: number;
    a: number;
    shN: number[];
}
export declare const enum ColIdx {
    x = 0,
    y = 1,
    z = 2,
    sx = 3,
    sy = 4,
    sz = 5,
    qx = 6,
    qy = 7,
    qz = 8,
    qw = 9,
    r = 10,
    g = 11,
    b = 12,
    a = 13,
    shOffset = 14
}
export declare class SplatData {
    counts: number;
    shDegree: number;
    shCounts: number;
    maxShDegree: number;
    table: Float32Array[];
    constructor(blockCounts?: number, maxShDegree?: number);
    blockOffsets: number[];
    blockContentCounts: number[];
    private blockCounts;
    private totalBlockCounts;
    private totalBlockShDegree;
    private blockExecs;
    private currentBlockIndex;
    initBlock(counts: number, shDegree: number): Promise<number>;
    finishBlock(): void;
    init(counts: number, shDegree: number): this;
    set(i: number, single: ISingleSplat): void;
    setCenter(i: number, x: number, y: number, z: number): void;
    setScale(i: number, sx: number, sy: number, sz: number): void;
    setQuat(i: number, qx: number, qy: number, qz: number, qw: number): void;
    setColor(i: number, r: number, g: number, b: number): void;
    setAlpha(i: number, a: number): void;
    setShN(i: number, shN: number[]): void;
    get(i: number, single: ISingleSplat): void;
    getCenter(i: number, single: ISingleSplat): void;
    getScale(i: number, single: ISingleSplat): void;
    getQuat(i: number, single: ISingleSplat): void;
    getColor(i: number, single: ISingleSplat): void;
    getAlpha(i: number, single: ISingleSplat): void;
    getShN(i: number, shN: number[]): void;
    destroy(): void;
}
