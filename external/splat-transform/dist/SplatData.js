import { Quaternion, deferred } from './utils/index.js';
import { SH_MAPS } from './constant.js';
const tempQuat = new Quaternion(0, 0, 0, 1);
export class SplatData {
    constructor(blockCounts = 1, maxShDegree = 3) {
        this.blockOffsets = [];
        this.blockContentCounts = [];
        this.totalBlockCounts = 0;
        this.totalBlockShDegree = 3;
        this.blockExecs = [];
        this.currentBlockIndex = 0;
        this.blockCounts = blockCounts;
        this.maxShDegree = maxShDegree;
    }
    initBlock(counts, shDegree) {
        this.blockContentCounts.push(counts);
        this.blockOffsets.push(this.totalBlockCounts);
        this.totalBlockCounts += counts;
        this.totalBlockShDegree = Math.min(shDegree, this.totalBlockShDegree);
        const { promise, resolve } = deferred();
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
    init(counts, shDegree) {
        this.counts = counts;
        this.shDegree = Math.min(shDegree, this.maxShDegree);
        const shCounts = this.shCounts = SH_MAPS[this.shDegree];
        this.table = new Array(14 + shCounts).fill(0).map(() => new Float32Array(counts));
        return this;
    }
    set(i, single) {
        const { table } = this;
        table[0 /* ColIdx.x */][i] = single.x;
        table[1 /* ColIdx.y */][i] = single.y;
        table[2 /* ColIdx.z */][i] = single.z;
        table[3 /* ColIdx.sx */][i] = single.sx;
        table[4 /* ColIdx.sy */][i] = single.sy;
        table[5 /* ColIdx.sz */][i] = single.sz;
        tempQuat.set(single.qx, single.qy, single.qz, single.qw).normalize();
        table[6 /* ColIdx.qx */][i] = tempQuat.x;
        table[7 /* ColIdx.qy */][i] = tempQuat.y;
        table[8 /* ColIdx.qz */][i] = tempQuat.z;
        table[9 /* ColIdx.qw */][i] = tempQuat.w;
        table[10 /* ColIdx.r */][i] = single.r;
        table[11 /* ColIdx.g */][i] = single.g;
        table[12 /* ColIdx.b */][i] = single.b;
        table[13 /* ColIdx.a */][i] = single.a;
    }
    setCenter(i, x, y, z) {
        const { table } = this;
        table[0 /* ColIdx.x */][i] = x;
        table[1 /* ColIdx.y */][i] = y;
        table[2 /* ColIdx.z */][i] = z;
    }
    setScale(i, sx, sy, sz) {
        const { table } = this;
        table[3 /* ColIdx.sx */][i] = sx;
        table[4 /* ColIdx.sy */][i] = sy;
        table[5 /* ColIdx.sz */][i] = sz;
    }
    setQuat(i, qx, qy, qz, qw) {
        const { table } = this;
        tempQuat.set(qx, qy, qz, qw).normalize();
        table[6 /* ColIdx.qx */][i] = tempQuat.x;
        table[7 /* ColIdx.qy */][i] = tempQuat.y;
        table[8 /* ColIdx.qz */][i] = tempQuat.z;
        table[9 /* ColIdx.qw */][i] = tempQuat.w;
    }
    setColor(i, r, g, b) {
        const { table } = this;
        table[10 /* ColIdx.r */][i] = r;
        table[11 /* ColIdx.g */][i] = g;
        table[12 /* ColIdx.b */][i] = b;
    }
    setAlpha(i, a) {
        const { table } = this;
        table[13 /* ColIdx.a */][i] = a;
    }
    setShN(i, shN) {
        const { table, shCounts } = this;
        for (let j = 0; j < shCounts; j++) {
            table[14 /* ColIdx.shOffset */ + j][i] = shN[j];
        }
    }
    ;
    get(i, single) {
        const { table } = this;
        single.x = table[0 /* ColIdx.x */][i];
        single.y = table[1 /* ColIdx.y */][i];
        single.z = table[2 /* ColIdx.z */][i];
        single.sx = table[3 /* ColIdx.sx */][i];
        single.sy = table[4 /* ColIdx.sy */][i];
        single.sz = table[5 /* ColIdx.sz */][i];
        single.qx = table[6 /* ColIdx.qx */][i];
        single.qy = table[7 /* ColIdx.qy */][i];
        single.qz = table[8 /* ColIdx.qz */][i];
        single.qw = table[9 /* ColIdx.qw */][i];
        single.r = table[10 /* ColIdx.r */][i];
        single.g = table[11 /* ColIdx.g */][i];
        single.b = table[12 /* ColIdx.b */][i];
        single.a = table[13 /* ColIdx.a */][i];
    }
    getCenter(i, single) {
        const { table } = this;
        single.x = table[0 /* ColIdx.x */][i];
        single.y = table[1 /* ColIdx.y */][i];
        single.z = table[2 /* ColIdx.z */][i];
    }
    getScale(i, single) {
        const { table } = this;
        single.sx = table[3 /* ColIdx.sx */][i];
        single.sy = table[4 /* ColIdx.sy */][i];
        single.sz = table[5 /* ColIdx.sz */][i];
    }
    getQuat(i, single) {
        const { table } = this;
        single.qx = table[6 /* ColIdx.qx */][i];
        single.qy = table[7 /* ColIdx.qy */][i];
        single.qz = table[8 /* ColIdx.qz */][i];
        single.qw = table[9 /* ColIdx.qw */][i];
    }
    getColor(i, single) {
        const { table } = this;
        single.r = table[10 /* ColIdx.r */][i];
        single.g = table[11 /* ColIdx.g */][i];
        single.b = table[12 /* ColIdx.b */][i];
    }
    getAlpha(i, single) {
        const { table } = this;
        single.a = table[13 /* ColIdx.a */][i];
    }
    getShN(i, shN) {
        const { shCounts, table } = this;
        for (let j = 0; j < shCounts; j++) {
            shN[j] = table[14 /* ColIdx.shOffset */ + j][i];
        }
    }
    destroy() {
        this.counts = 0;
        this.table = [];
    }
}
