import { Quaternion, deferred, type ISplatData } from './utils/index.js';
import { SH_MAPS } from './constant.js';

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

export enum ColIdx {
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
    shOffset = 14,
}

const tempQuat = new Quaternion(0, 0, 0, 1);
export class SplatData {
    counts: number;
    shDegree: number;
    shCounts: number;
    maxShDegree: number;
    table: Float32Array[];

    constructor(blockCounts: number = 1, maxShDegree: number = 3) {
        this.blockCounts = blockCounts;
        this.maxShDegree = maxShDegree;
    }

    blockOffsets: number[] = [];
    blockContentCounts: number[] = [];
    private blockCounts: number;
    private totalBlockCounts: number = 0;
    private totalBlockShDegree: number = 3;
    private blockExecs: Function[] = [];
    private currentBlockIndex: number = 0;
    initBlock(counts: number, shDegree: number) {
        this.blockContentCounts.push(counts);
        this.blockOffsets.push(this.totalBlockCounts);
        this.totalBlockCounts += counts;
        this.totalBlockShDegree = Math.min(shDegree, this.totalBlockShDegree);
        const { promise, resolve } = deferred<number>();
        this.blockExecs.push(resolve);
        if (this.blockOffsets.length === this.blockCounts) {
            this.init(this.totalBlockCounts, this.totalBlockShDegree);
            this.blockExecs[this.currentBlockIndex](this.blockOffsets[0]);
        }
        return promise;
    }

    finishBlock() {
        this.currentBlockIndex++;
        this.blockExecs[this.currentBlockIndex]?.(this.blockOffsets[this.currentBlockIndex]);
    }

    init(counts: number, shDegree: number) {
        this.counts = counts;
        this.shDegree = Math.min(shDegree, this.maxShDegree);
        const shCounts = (this.shCounts = SH_MAPS[this.shDegree]);
        this.table = new Array(14 + shCounts).fill(0).map(() => new Float32Array(counts));
        return this;
    }

    set(i: number, single: ISingleSplat) {
        const { table } = this;

        table[ColIdx.x][i] = single.x;
        table[ColIdx.y][i] = single.y;
        table[ColIdx.z][i] = single.z;

        table[ColIdx.sx][i] = single.sx;
        table[ColIdx.sy][i] = single.sy;
        table[ColIdx.sz][i] = single.sz;

        tempQuat.set(single.qx, single.qy, single.qz, single.qw).normalize();
        table[ColIdx.qx][i] = tempQuat.x;
        table[ColIdx.qy][i] = tempQuat.y;
        table[ColIdx.qz][i] = tempQuat.z;
        table[ColIdx.qw][i] = tempQuat.w;

        table[ColIdx.r][i] = single.r;
        table[ColIdx.g][i] = single.g;
        table[ColIdx.b][i] = single.b;
        table[ColIdx.a][i] = single.a;
    }

    setCenter(i: number, x: number, y: number, z: number) {
        const { table } = this;
        table[ColIdx.x][i] = x;
        table[ColIdx.y][i] = y;
        table[ColIdx.z][i] = z;
    }

    setScale(i: number, sx: number, sy: number, sz: number) {
        const { table } = this;
        table[ColIdx.sx][i] = sx;
        table[ColIdx.sy][i] = sy;
        table[ColIdx.sz][i] = sz;
    }

    setQuat(i: number, qx: number, qy: number, qz: number, qw: number) {
        const { table } = this;
        tempQuat.set(qx, qy, qz, qw).normalize();
        table[ColIdx.qx][i] = tempQuat.x;
        table[ColIdx.qy][i] = tempQuat.y;
        table[ColIdx.qz][i] = tempQuat.z;
        table[ColIdx.qw][i] = tempQuat.w;
    }

    setColor(i: number, r: number, g: number, b: number) {
        const { table } = this;
        table[ColIdx.r][i] = r;
        table[ColIdx.g][i] = g;
        table[ColIdx.b][i] = b;
    }

    setAlpha(i: number, a: number) {
        const { table } = this;
        table[ColIdx.a][i] = a;
    }

    setShN(i: number, shN: number[]) {
        const { table, shCounts } = this;
        for (let j = 0; j < shCounts; j++) {
            table[ColIdx.shOffset + j][i] = shN[j];
        }
    }

    get(i: number, single: ISingleSplat) {
        const { table } = this;
        single.x = table[ColIdx.x][i];
        single.y = table[ColIdx.y][i];
        single.z = table[ColIdx.z][i];
        single.sx = table[ColIdx.sx][i];
        single.sy = table[ColIdx.sy][i];
        single.sz = table[ColIdx.sz][i];
        single.qx = table[ColIdx.qx][i];
        single.qy = table[ColIdx.qy][i];
        single.qz = table[ColIdx.qz][i];
        single.qw = table[ColIdx.qw][i];
        single.r = table[ColIdx.r][i];
        single.g = table[ColIdx.g][i];
        single.b = table[ColIdx.b][i];
        single.a = table[ColIdx.a][i];
    }

    getCenter(i: number, single: ISingleSplat) {
        const { table } = this;
        single.x = table[ColIdx.x][i];
        single.y = table[ColIdx.y][i];
        single.z = table[ColIdx.z][i];
    }

    getScale(i: number, single: ISingleSplat) {
        const { table } = this;
        single.sx = table[ColIdx.sx][i];
        single.sy = table[ColIdx.sy][i];
        single.sz = table[ColIdx.sz][i];
    }

    getQuat(i: number, single: ISingleSplat) {
        const { table } = this;
        single.qx = table[ColIdx.qx][i];
        single.qy = table[ColIdx.qy][i];
        single.qz = table[ColIdx.qz][i];
        single.qw = table[ColIdx.qw][i];
    }

    getColor(i: number, single: ISingleSplat) {
        const { table } = this;
        single.r = table[ColIdx.r][i];
        single.g = table[ColIdx.g][i];
        single.b = table[ColIdx.b][i];
    }

    getAlpha(i: number, single: ISingleSplat) {
        const { table } = this;
        single.a = table[ColIdx.a][i];
    }

    getShN(i: number, shN: number[]) {
        const { shCounts, table } = this;
        for (let j = 0; j < shCounts; j++) {
            shN[j] = table[ColIdx.shOffset + j][i];
        }
    }

    destroy() {
        this.counts = 0;
        this.table = [];
    }

    serialize(): ISplatData {
        return {
            counts: this.counts,
            shDegree: this.shDegree,
            table: this.table,
        };
    }

    deserialize(data: ISplatData) {
        const { counts, shDegree, table } = data;
        this.counts = counts;
        this.shDegree = shDegree;
        this.shCounts = SH_MAPS[shDegree];
        this.table = table;
    }
}
