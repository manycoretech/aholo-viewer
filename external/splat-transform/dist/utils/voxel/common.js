/** 3D Morton (Z-order) for integer block coordinates. */
export const encodeMorton3 = (x, y, z) => {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 17; i++) {
        if (x & 1) {
            result += shift;
        }
        if (y & 1) {
            result += shift * 2;
        }
        if (z & 1) {
            result += shift * 4;
        }
        x >>>= 1;
        y >>>= 1;
        z >>>= 1;
        shift *= 8;
    }
    return result;
};
export const decodeMorton3 = (m) => {
    let x = 0, y = 0, z = 0;
    let bit = 1;
    while (m > 0) {
        const triplet = m % 8;
        if (triplet & 1) {
            x |= bit;
        }
        if (triplet & 2) {
            y |= bit;
        }
        if (triplet & 4) {
            z |= bit;
        }
        bit <<= 1;
        m = Math.trunc(m / 8);
    }
    return [x, y, z];
};
/** Voxel leaf edge length in voxels (4³ block). */
export const LEAF_SIZE = 4;
export const ALPHA_THRESHOLD = 1. / 255.;
export const alignGridBounds = (bounds, voxelResolution) => {
    const blockSize = LEAF_SIZE * voxelResolution;
    return {
        min: {
            x: Math.floor(bounds.min.x / blockSize) * blockSize,
            y: Math.floor(bounds.min.y / blockSize) * blockSize,
            z: Math.floor(bounds.min.z / blockSize) * blockSize
        },
        max: {
            x: Math.ceil(bounds.max.x / blockSize) * blockSize,
            y: Math.ceil(bounds.max.y / blockSize) * blockSize,
            z: Math.ceil(bounds.max.z / blockSize) * blockSize
        }
    };
};
/** Opacity-aware AABB half-extents from scale + unit quaternion. */
export const extentsFromQuatScale = (sx, sy, sz, qx, qy, qz, qw, opacity, opacityThreshold = ALPHA_THRESHOLD) => {
    let extend = 3;
    if (opacity !== undefined &&
        opacity > opacityThreshold) {
        // Tight bound from opacity threshold, clamped by default 3-sigma bound.
        const opacityAware = Math.sqrt(2 * Math.log(opacity / opacityThreshold));
        if (Number.isFinite(opacityAware)) {
            extend = Math.min(extend, opacityAware);
        }
    }
    else if (opacity !== undefined && opacity <= opacityThreshold) {
        return { ex: 0, ey: 0, ez: 0 };
    }
    const sX = extend * sx;
    const sY = extend * sy;
    const sZ = extend * sz;
    const xx = qx * qx;
    const yy = qy * qy;
    const zz = qz * qz;
    const xy = qx * qy;
    const xz = qx * qz;
    const yz = qy * qz;
    const wx = qw * qx;
    const wy = qw * qy;
    const wz = qw * qz;
    const m00 = 1 - 2 * (yy + zz);
    const m01 = 2 * (xy - wz);
    const m02 = 2 * (xz + wy);
    const m10 = 2 * (xy + wz);
    const m11 = 1 - 2 * (xx + zz);
    const m12 = 2 * (yz - wx);
    const m20 = 2 * (xz - wy);
    const m21 = 2 * (yz + wx);
    const m22 = 1 - 2 * (xx + yy);
    const abs00 = Math.abs(m00);
    const abs01 = Math.abs(m01);
    const abs02 = Math.abs(m02);
    const abs10 = Math.abs(m10);
    const abs11 = Math.abs(m11);
    const abs12 = Math.abs(m12);
    const abs20 = Math.abs(m20);
    const abs21 = Math.abs(m21);
    const abs22 = Math.abs(m22);
    const ex = abs00 * sX + abs01 * sY + abs02 * sZ;
    const ey = abs10 * sX + abs11 * sY + abs12 * sZ;
    const ez = abs20 * sX + abs21 * sY + abs22 * sZ;
    return { ex, ey, ez };
};
const boundsOverlap = (a, bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ) => {
    return !(a.maxX < bMinX || a.minX > bMaxX || a.maxY < bMinY || a.minY > bMaxY || a.maxZ < bMinZ || a.minZ > bMaxZ);
};
const quickselect = (axisData, idx, k) => {
    const valAt = (p) => axisData[idx[p]];
    const swap = (i, j) => {
        const t = idx[i];
        idx[i] = idx[j];
        idx[j] = t;
    };
    const n = idx.length;
    let l = 0;
    let r = n - 1;
    while (true) {
        if (r <= l + 1) {
            if (r === l + 1 && valAt(r) < valAt(l)) {
                swap(l, r);
            }
            return idx[k];
        }
        const mid = (l + r) >>> 1;
        swap(mid, l + 1);
        if (valAt(l) > valAt(r)) {
            swap(l, r);
        }
        if (valAt(l + 1) > valAt(r)) {
            swap(l + 1, r);
        }
        if (valAt(l) > valAt(l + 1)) {
            swap(l, l + 1);
        }
        let i = l + 1;
        let j = r;
        const pivotIdxVal = valAt(l + 1);
        const pivotIdx = idx[l + 1];
        while (true) {
            do {
                i++;
            } while (i <= r && valAt(i) < pivotIdxVal);
            do {
                j--;
            } while (j >= l && valAt(j) > pivotIdxVal);
            if (j < i) {
                break;
            }
            swap(i, j);
        }
        idx[l + 1] = idx[j];
        idx[j] = pivotIdx;
        if (j >= k) {
            r = j - 1;
        }
        if (j <= k) {
            l = i;
        }
    }
};
export class GaussianBVH {
    static MAX_LEAF_SIZE = 64;
    x;
    y;
    z;
    extents;
    root;
    constructor(x, y, z, extents) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.extents = extents;
        const indices = new Uint32Array(x.length);
        for (let i = 0; i < x.length; i++) {
            indices[i] = i;
        }
        this.root = this.buildNode(indices);
    }
    queryOverlappingRaw(minX, minY, minZ, maxX, maxY, maxZ) {
        const result = [];
        this.queryNode(this.root, minX, minY, minZ, maxX, maxY, maxZ, result);
        return result;
    }
    queryOverlappingRawInto(minX, minY, minZ, maxX, maxY, maxZ, output, offset = 0) {
        return this.queryNodeInto(this.root, minX, minY, minZ, maxX, maxY, maxZ, output, offset, 0);
    }
    computeBounds(indices) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            const ex = this.extents[idx * 3], ey = this.extents[idx * 3 + 1], ez = this.extents[idx * 3 + 2];
            const gx = this.x[idx], gy = this.y[idx], gz = this.z[idx];
            if (gx - ex < minX) {
                minX = gx - ex;
            }
            if (gy - ey < minY) {
                minY = gy - ey;
            }
            if (gz - ez < minZ) {
                minZ = gz - ez;
            }
            if (gx + ex > maxX) {
                maxX = gx + ex;
            }
            if (gy + ey > maxY) {
                maxY = gy + ey;
            }
            if (gz + ez > maxZ) {
                maxZ = gz + ez;
            }
        }
        return { minX, minY, minZ, maxX, maxY, maxZ };
    }
    buildNode(indices) {
        const bounds = this.computeBounds(indices);
        if (indices.length <= GaussianBVH.MAX_LEAF_SIZE) {
            return { bounds, indices };
        }
        let minCx = Infinity, minCy = Infinity, minCz = Infinity;
        let maxCx = -Infinity, maxCy = -Infinity, maxCz = -Infinity;
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            const cx = this.x[idx], cy = this.y[idx], cz = this.z[idx];
            if (cx < minCx) {
                minCx = cx;
            }
            if (cy < minCy) {
                minCy = cy;
            }
            if (cz < minCz) {
                minCz = cz;
            }
            if (cx > maxCx) {
                maxCx = cx;
            }
            if (cy > maxCy) {
                maxCy = cy;
            }
            if (cz > maxCz) {
                maxCz = cz;
            }
        }
        const ex = maxCx - minCx, ey = maxCy - minCy, ez = maxCz - minCz;
        const axis = ex >= ey && ex >= ez ? this.x : (ey >= ez ? this.y : this.z);
        const mid = indices.length >>> 1;
        quickselect(axis, indices, mid);
        return { bounds, left: this.buildNode(indices.subarray(0, mid)), right: this.buildNode(indices.subarray(mid)) };
    }
    queryNode(node, minX, minY, minZ, maxX, maxY, maxZ, result) {
        if (!boundsOverlap(node.bounds, minX, minY, minZ, maxX, maxY, maxZ)) {
            return;
        }
        if (node.indices) {
            for (let i = 0; i < node.indices.length; i++) {
                const idx = node.indices[i];
                const ex = this.extents[idx * 3], ey = this.extents[idx * 3 + 1], ez = this.extents[idx * 3 + 2];
                const gx = this.x[idx], gy = this.y[idx], gz = this.z[idx];
                if (!(gx + ex < minX || gx - ex > maxX || gy + ey < minY || gy - ey > maxY || gz + ez < minZ || gz - ez > maxZ)) {
                    result.push(idx);
                }
            }
            return;
        }
        if (node.left) {
            this.queryNode(node.left, minX, minY, minZ, maxX, maxY, maxZ, result);
        }
        if (node.right) {
            this.queryNode(node.right, minX, minY, minZ, maxX, maxY, maxZ, result);
        }
    }
    queryNodeInto(node, minX, minY, minZ, maxX, maxY, maxZ, output, offset, count) {
        if (!boundsOverlap(node.bounds, minX, minY, minZ, maxX, maxY, maxZ)) {
            return count;
        }
        if (node.indices) {
            for (let i = 0; i < node.indices.length; i++) {
                const idx = node.indices[i];
                const ex = this.extents[idx * 3], ey = this.extents[idx * 3 + 1], ez = this.extents[idx * 3 + 2];
                const gx = this.x[idx], gy = this.y[idx], gz = this.z[idx];
                if (!(gx + ex < minX || gx - ex > maxX || gy + ey < minY || gy - ey > maxY || gz + ez < minZ || gz - ez > maxZ)) {
                    if (offset + count < output.length) {
                        output[offset + count] = idx;
                    }
                    count++;
                }
            }
            return count;
        }
        if (node.left) {
            count = this.queryNodeInto(node.left, minX, minY, minZ, maxX, maxY, maxZ, output, offset, count);
        }
        if (node.right) {
            count = this.queryNodeInto(node.right, minX, minY, minZ, maxX, maxY, maxZ, output, offset, count);
        }
        return count;
    }
}
const SOLID_LO = 0xFFFFFFFF >>> 0;
const SOLID_HI = 0xFFFFFFFF >>> 0;
const SOLID_MASK = 0xFFFFFFFF >>> 0;
const INITIAL_BLOCK_BUFFER_CAPACITY = 1024;
const growFloat64 = (src, newCap) => {
    const grown = new Float64Array(newCap);
    grown.set(src);
    return grown;
};
const growUint32 = (src, newCap) => {
    const grown = new Uint32Array(newCap);
    grown.set(src);
    return grown;
};
/**
 * Append-only buffer for streaming voxelization results.
 * Stores (linear blockIdx, voxel mask) pairs for non-empty 4x4x4 blocks.
 *
 * Block keys are linear block indices `bx + by*nbx + bz*nbx*nby` in the
 * producer's grid coordinate system. Producers and consumers must agree on
 * the grid dimensions; the buffer itself is dimension-agnostic.
 */
export class BlockMaskBuffer {
    solidIdx = new Float64Array(0);
    solidCountValue = 0;
    solidCap = 0;
    mixedIdx = new Float64Array(0);
    mixedCountValue = 0;
    mixedCap = 0;
    mixedMasks = new Uint32Array(0);
    addBlock(blockIdx, lo, hi) {
        if ((lo | hi) === 0) {
            return;
        }
        if ((lo >>> 0) === SOLID_MASK && (hi >>> 0) === SOLID_MASK) {
            if (this.solidCountValue === this.solidCap) {
                this.solidCap = this.solidCap === 0 ? INITIAL_BLOCK_BUFFER_CAPACITY : this.solidCap * 2;
                this.solidIdx = growFloat64(this.solidIdx, this.solidCap);
            }
            this.solidIdx[this.solidCountValue++] = blockIdx;
            return;
        }
        if (this.mixedCountValue === this.mixedCap) {
            this.mixedCap = this.mixedCap === 0 ? INITIAL_BLOCK_BUFFER_CAPACITY : this.mixedCap * 2;
            this.mixedIdx = growFloat64(this.mixedIdx, this.mixedCap);
            this.mixedMasks = growUint32(this.mixedMasks, this.mixedCap * 2);
        }
        this.mixedIdx[this.mixedCountValue] = blockIdx;
        this.mixedMasks[this.mixedCountValue * 2] = lo >>> 0;
        this.mixedMasks[this.mixedCountValue * 2 + 1] = hi >>> 0;
        this.mixedCountValue++;
    }
    getMixedBlocks() {
        return {
            blockIdx: this.mixedIdx.subarray(0, this.mixedCountValue),
            masks: this.mixedMasks.subarray(0, this.mixedCountValue * 2)
        };
    }
    getSolidBlocks() {
        return this.solidIdx.subarray(0, this.solidCountValue);
    }
    get count() {
        return this.mixedCountValue + this.solidCountValue;
    }
    get mixedCount() {
        return this.mixedCountValue;
    }
    get solidCount() {
        return this.solidCountValue;
    }
    clear() {
        this.solidIdx = new Float64Array(0);
        this.solidCountValue = 0;
        this.solidCap = 0;
        this.mixedIdx = new Float64Array(0);
        this.mixedMasks = new Uint32Array(0);
        this.mixedCountValue = 0;
        this.mixedCap = 0;
    }
}
const BLOCK_EMPTY = 0;
const BLOCK_SOLID = 1;
const BLOCK_MIXED = 2;
const TYPE_MASK = 0x3;
const BLOCKS_PER_WORD = 16;
const EVEN_BITS = 0x55555555 >>> 0;
const readBlockType = (types, blockIdx) => {
    const word = blockIdx >>> 4;
    const shift = (blockIdx & 15) << 1;
    return (types[word] >>> shift) & TYPE_MASK;
};
const writeBlockType = (types, blockIdx, blockType) => {
    const word = blockIdx >>> 4;
    const shift = (blockIdx & 15) << 1;
    const mask = TYPE_MASK << shift;
    types[word] = (types[word] & (~mask)) | ((blockType & TYPE_MASK) << shift);
};
const EMPTY = -1;
class BlockMaskMap {
    keys;
    lo;
    hi;
    _size;
    _capacity;
    _mask;
    constructor(initialCapacity = 4096) {
        const cap = 1 << (32 - Math.clz32(Math.max(15, initialCapacity - 1)));
        this._capacity = cap;
        this._mask = cap - 1;
        this._size = 0;
        this.keys = new Int32Array(cap).fill(EMPTY);
        this.lo = new Uint32Array(cap);
        this.hi = new Uint32Array(cap);
    }
    slot(key) {
        const mask = this._mask;
        let i = (Math.imul(key, 0x9E3779B9) >>> 0) & mask;
        while (true) {
            const k = this.keys[i];
            if (k === key || k === EMPTY) {
                return i;
            }
            i = (i + 1) & mask;
        }
    }
    set(key, loVal, hiVal) {
        let s = this.slot(key);
        if (this.keys[s] === EMPTY) {
            this.keys[s] = key;
            this._size++;
            if (this._size > ((this._capacity * 0.7) | 0)) {
                this._grow();
                s = this.slot(key);
            }
        }
        this.lo[s] = loVal;
        this.hi[s] = hiVal;
    }
    removeAt(slot) {
        this._size--;
        const mask = this._mask;
        let i = slot;
        let j = slot;
        while (true) {
            j = (j + 1) & mask;
            if (this.keys[j] === EMPTY) {
                break;
            }
            const k = ((Math.imul(this.keys[j], 0x9E3779B9) >>> 0) & mask);
            if ((i < j) ? (k <= i || k > j) : (k <= i && k > j)) {
                this.keys[i] = this.keys[j];
                this.lo[i] = this.lo[j];
                this.hi[i] = this.hi[j];
                i = j;
            }
        }
        this.keys[i] = EMPTY;
    }
    clear() {
        this.keys.fill(EMPTY);
        this._size = 0;
    }
    get size() {
        return this._size;
    }
    releaseStorage() {
        this.keys = new Int32Array(0);
        this.lo = new Uint32Array(0);
        this.hi = new Uint32Array(0);
        this._size = 0;
        this._capacity = 0;
        this._mask = 0;
    }
    clone() {
        const c = new BlockMaskMap(this._capacity);
        c.keys.set(this.keys);
        c.lo.set(this.lo);
        c.hi.set(this.hi);
        c._size = this._size;
        return c;
    }
    _grow() {
        const oldKeys = this.keys;
        const oldLo = this.lo;
        const oldHi = this.hi;
        const oldCap = this._capacity;
        this._capacity *= 2;
        this._mask = this._capacity - 1;
        this.keys = new Int32Array(this._capacity).fill(EMPTY);
        this.lo = new Uint32Array(this._capacity);
        this.hi = new Uint32Array(this._capacity);
        this._size = 0;
        for (let i = 0; i < oldCap; i++) {
            if (oldKeys[i] !== EMPTY) {
                const s = this.slot(oldKeys[i]);
                this.keys[s] = oldKeys[i];
                this.lo[s] = oldLo[i];
                this.hi[s] = oldHi[i];
                this._size++;
            }
        }
    }
}
class SparseVoxelGrid {
    nx;
    ny;
    nz;
    nbx;
    nby;
    nbz;
    bStride;
    types;
    masks;
    constructor(nx, ny, nz) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.nbx = nx >> 2;
        this.nby = ny >> 2;
        this.nbz = nz >> 2;
        this.bStride = this.nbx * this.nby;
        const totalBlocks = this.nbx * this.nby * this.nbz;
        this.types = new Uint32Array((totalBlocks + BLOCKS_PER_WORD - 1) >>> 4);
        this.masks = new BlockMaskMap();
    }
    getVoxel(ix, iy, iz) {
        const blockIdx = (ix >> 2) + (iy >> 2) * this.nbx + (iz >> 2) * this.bStride;
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_EMPTY) {
            return 0;
        }
        if (bt === BLOCK_SOLID) {
            return 1;
        }
        const s = this.masks.slot(blockIdx);
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        return bitIdx < 32 ? (this.masks.lo[s] >>> bitIdx) & 1 : (this.masks.hi[s] >>> (bitIdx - 32)) & 1;
    }
    setVoxel(ix, iy, iz) {
        const blockIdx = (ix >> 2) + (iy >> 2) * this.nbx + (iz >> 2) * this.bStride;
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_SOLID) {
            return;
        }
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        if (bt === BLOCK_MIXED) {
            const s = this.masks.slot(blockIdx);
            if (bitIdx < 32) {
                this.masks.lo[s] = (this.masks.lo[s] | (1 << bitIdx)) >>> 0;
            }
            else {
                this.masks.hi[s] = (this.masks.hi[s] | (1 << (bitIdx - 32))) >>> 0;
            }
            if (this.masks.lo[s] === SOLID_LO && this.masks.hi[s] === SOLID_HI) {
                this.masks.removeAt(s);
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            }
        }
        else {
            writeBlockType(this.types, blockIdx, BLOCK_MIXED);
            this.masks.set(blockIdx, bitIdx < 32 ? (1 << bitIdx) >>> 0 : 0, bitIdx >= 32 ? (1 << (bitIdx - 32)) >>> 0 : 0);
        }
    }
    orBlock(blockIdx, lo, hi) {
        if (lo === 0 && hi === 0) {
            return;
        }
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_SOLID) {
            return;
        }
        if (bt === BLOCK_MIXED) {
            const s = this.masks.slot(blockIdx);
            this.masks.lo[s] = (this.masks.lo[s] | lo) >>> 0;
            this.masks.hi[s] = (this.masks.hi[s] | hi) >>> 0;
            if (this.masks.lo[s] === SOLID_LO && this.masks.hi[s] === SOLID_HI) {
                this.masks.removeAt(s);
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            }
        }
        else {
            if ((lo >>> 0) === SOLID_LO && (hi >>> 0) === SOLID_HI) {
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            }
            else {
                writeBlockType(this.types, blockIdx, BLOCK_MIXED);
                this.masks.set(blockIdx, lo >>> 0, hi >>> 0);
            }
        }
    }
    clear() {
        this.types.fill(0);
        this.masks.clear();
    }
    releaseStorage() {
        this.types = new Uint32Array(0);
        this.masks.releaseStorage();
    }
    clone() {
        const g = new SparseVoxelGrid(this.nx, this.ny, this.nz);
        g.types.set(this.types);
        g.masks = this.masks.clone();
        return g;
    }
    cropTo(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz, onProgress) {
        const outNbx = cropMaxBx - cropMinBx;
        const outNby = cropMaxBy - cropMinBy;
        const outNbz = cropMaxBz - cropMinBz;
        const out = new SparseVoxelGrid(outNbx * 4, outNby * 4, outNbz * 4);
        const outBStride = outNbx * outNby;
        const { nbx, nby } = this;
        const totalBlocks = nbx * nby * this.nbz;
        const types = this.types;
        const masks = this.masks;
        const outTypes = out.types;
        const outMasks = out.masks;
        if (out.nbx * out.nby * out.nbz === 0) {
            if (onProgress) {
                onProgress(0, 0);
            }
            return out;
        }
        const PROGRESS_INTERVAL = 1 << 13;
        let nextTick = PROGRESS_INTERVAL;
        for (let w = 0; w < types.length; w++) {
            if (onProgress && w >= nextTick) {
                onProgress(w, types.length);
                nextTick = w + PROGRESS_INTERVAL;
            }
            const word = types[w];
            if (word === 0) {
                continue;
            }
            let nonEmpty = ((word & EVEN_BITS) | ((word >>> 1) & EVEN_BITS)) >>> 0;
            const baseIdx = w * BLOCKS_PER_WORD;
            let bx = baseIdx % nbx;
            const byBz = (baseIdx / nbx) | 0;
            let by = byBz % nby;
            let bz = (byBz / nby) | 0;
            let coordLane = 0;
            while (nonEmpty) {
                const bp = 31 - Math.clz32(nonEmpty & -nonEmpty);
                const lane = bp >>> 1;
                nonEmpty &= nonEmpty - 1;
                const blockIdx = baseIdx + lane;
                if (blockIdx >= totalBlocks) {
                    break;
                }
                bx += lane - coordLane;
                coordLane = lane;
                while (bx >= nbx) {
                    bx -= nbx;
                    by++;
                    if (by >= nby) {
                        by = 0;
                        bz++;
                    }
                }
                if (bx < cropMinBx || bx >= cropMaxBx ||
                    by < cropMinBy || by >= cropMaxBy ||
                    bz < cropMinBz || bz >= cropMaxBz) {
                    continue;
                }
                const outIdx = (bx - cropMinBx) + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outBStride;
                const bt = (word >>> (lane << 1)) & TYPE_MASK;
                writeBlockType(outTypes, outIdx, bt);
                if (bt === BLOCK_MIXED) {
                    const s = masks.slot(blockIdx);
                    outMasks.set(outIdx, masks.lo[s], masks.hi[s]);
                }
            }
        }
        if (onProgress) {
            onProgress(types.length, types.length);
        }
        return out;
    }
    cropToInverted(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz, onProgress) {
        const outNbx = cropMaxBx - cropMinBx;
        const outNby = cropMaxBy - cropMinBy;
        const outNbz = cropMaxBz - cropMinBz;
        const out = new SparseVoxelGrid(outNbx * 4, outNby * 4, outNbz * 4);
        const outBStride = outNbx * outNby;
        const outTotalBlocks = outNbx * outNby * outNbz;
        const outTypes = out.types;
        const outMasks = out.masks;
        if (outTotalBlocks === 0) {
            if (onProgress) {
                onProgress(0, 0);
            }
            return out;
        }
        const SOLID_WORD = 0x55555555 >>> 0;
        outTypes.fill(SOLID_WORD);
        const lastWord = outTypes.length - 1;
        const lastLanes = outTotalBlocks - lastWord * BLOCKS_PER_WORD;
        if (lastLanes < BLOCKS_PER_WORD) {
            const validBits = (1 << (lastLanes * 2)) - 1;
            outTypes[lastWord] = (outTypes[lastWord] & validBits) >>> 0;
        }
        const { nbx, nby } = this;
        const types = this.types;
        const masks = this.masks;
        const totalBlocks = nbx * nby * this.nbz;
        const PROGRESS_INTERVAL = 1 << 13;
        let nextTick = PROGRESS_INTERVAL;
        for (let w = 0; w < types.length; w++) {
            if (onProgress && w >= nextTick) {
                onProgress(w, types.length);
                nextTick = w + PROGRESS_INTERVAL;
            }
            const word = types[w];
            if (word === 0) {
                continue;
            }
            let nonEmpty = ((word & EVEN_BITS) | ((word >>> 1) & EVEN_BITS)) >>> 0;
            const baseIdx = w * BLOCKS_PER_WORD;
            let bx = baseIdx % nbx;
            const byBz = (baseIdx / nbx) | 0;
            let by = byBz % nby;
            let bz = (byBz / nby) | 0;
            let coordLane = 0;
            while (nonEmpty) {
                const bp = 31 - Math.clz32(nonEmpty & -nonEmpty);
                const lane = bp >>> 1;
                nonEmpty &= nonEmpty - 1;
                const blockIdx = baseIdx + lane;
                if (blockIdx >= totalBlocks) {
                    break;
                }
                bx += lane - coordLane;
                coordLane = lane;
                while (bx >= nbx) {
                    bx -= nbx;
                    by++;
                    if (by >= nby) {
                        by = 0;
                        bz++;
                    }
                }
                if (bx < cropMinBx || bx >= cropMaxBx ||
                    by < cropMinBy || by >= cropMaxBy ||
                    bz < cropMinBz || bz >= cropMaxBz) {
                    continue;
                }
                const outIdx = (bx - cropMinBx) + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outBStride;
                const bt = (word >>> (lane << 1)) & TYPE_MASK;
                if (bt === BLOCK_SOLID) {
                    writeBlockType(outTypes, outIdx, BLOCK_EMPTY);
                }
                else {
                    writeBlockType(outTypes, outIdx, BLOCK_MIXED);
                    const s = masks.slot(blockIdx);
                    outMasks.set(outIdx, (~masks.lo[s]) >>> 0, (~masks.hi[s]) >>> 0);
                }
            }
        }
        if (onProgress) {
            onProgress(types.length, types.length);
        }
        return out;
    }
    static fromBuffer(acc, nx, ny, nz) {
        const g = new SparseVoxelGrid(nx, ny, nz);
        const solidBlocks = acc.getSolidBlocks();
        const totalBlocks = g.nbx * g.nby * g.nbz;
        for (let i = 0; i < solidBlocks.length; i++) {
            const blockIdx = solidBlocks[i];
            if (blockIdx < 0 || blockIdx >= totalBlocks) {
                continue;
            }
            writeBlockType(g.types, blockIdx, BLOCK_SOLID);
        }
        const mixed = acc.getMixedBlocks();
        for (let i = 0; i < mixed.blockIdx.length; i++) {
            const blockIdx = mixed.blockIdx[i];
            if (blockIdx < 0 || blockIdx >= totalBlocks) {
                continue;
            }
            if (readBlockType(g.types, blockIdx) === BLOCK_SOLID) {
                continue;
            }
            writeBlockType(g.types, blockIdx, BLOCK_MIXED);
            g.masks.set(blockIdx, mixed.masks[i * 2], mixed.masks[i * 2 + 1]);
        }
        return g;
    }
    toBuffer(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz, defaultSolid = false) {
        const out = new BlockMaskBuffer();
        for (let bz = cropMinBz; bz < cropMaxBz; bz++) {
            for (let by = cropMinBy; by < cropMaxBy; by++) {
                for (let bx = cropMinBx; bx < cropMaxBx; bx++) {
                    const blockIdx = bx + by * this.nbx + bz * this.bStride;
                    const bt = readBlockType(this.types, blockIdx);
                    let lo;
                    let hi;
                    if (bt === BLOCK_SOLID) {
                        lo = SOLID_LO;
                        hi = SOLID_HI;
                    }
                    else if (bt === BLOCK_MIXED) {
                        const s = this.masks.slot(blockIdx);
                        lo = this.masks.lo[s];
                        hi = this.masks.hi[s];
                    }
                    else if (defaultSolid) {
                        lo = SOLID_LO;
                        hi = SOLID_HI;
                    }
                    else {
                        continue;
                    }
                    if ((lo | hi) !== 0) {
                        const outNbx = cropMaxBx - cropMinBx;
                        const outNby = cropMaxBy - cropMinBy;
                        out.addBlock((bx - cropMinBx) + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outNbx * outNby, lo, hi);
                    }
                }
            }
        }
        return out;
    }
    toBufferInverted(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz) {
        const out = new BlockMaskBuffer();
        for (let bz = cropMinBz; bz < cropMaxBz; bz++) {
            for (let by = cropMinBy; by < cropMaxBy; by++) {
                for (let bx = cropMinBx; bx < cropMaxBx; bx++) {
                    const blockIdx = bx + by * this.nbx + bz * this.bStride;
                    const bt = readBlockType(this.types, blockIdx);
                    let lo;
                    let hi;
                    if (bt === BLOCK_SOLID) {
                        continue;
                    }
                    if (bt === BLOCK_MIXED) {
                        const s = this.masks.slot(blockIdx);
                        lo = (~this.masks.lo[s]) >>> 0;
                        hi = (~this.masks.hi[s]) >>> 0;
                    }
                    else {
                        lo = SOLID_LO;
                        hi = SOLID_HI;
                    }
                    if ((lo | hi) !== 0) {
                        const outNbx = cropMaxBx - cropMinBx;
                        const outNby = cropMaxBy - cropMinBy;
                        out.addBlock((bx - cropMinBx) + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outNbx * outNby, lo, hi);
                    }
                }
            }
        }
        return out;
    }
    getOccupiedBlockBounds(onProgress) {
        const { nbx, nby } = this;
        const totalBlocks = nbx * nby * this.nbz;
        let minBx = nbx, minBy = nby, minBz = this.nbz;
        let maxBx = 0, maxBy = 0, maxBz = 0;
        let found = false;
        const PROGRESS_INTERVAL = 1 << 13;
        let nextTick = PROGRESS_INTERVAL;
        for (let w = 0; w < this.types.length; w++) {
            if (onProgress && w >= nextTick) {
                onProgress(w, this.types.length);
                nextTick = w + PROGRESS_INTERVAL;
            }
            const word = this.types[w];
            if (word === 0) {
                continue;
            }
            let nonEmpty = ((word & EVEN_BITS) | ((word >>> 1) & EVEN_BITS)) >>> 0;
            const baseIdx = w * BLOCKS_PER_WORD;
            let bx = baseIdx % nbx;
            const byBz = (baseIdx / nbx) | 0;
            let by = byBz % nby;
            let bz = (byBz / nby) | 0;
            let coordLane = 0;
            while (nonEmpty) {
                const bitPos = 31 - Math.clz32(nonEmpty & -nonEmpty);
                const lane = bitPos >>> 1;
                const blockIdx = baseIdx + lane;
                if (blockIdx >= totalBlocks) {
                    nonEmpty = 0;
                    break;
                }
                bx += lane - coordLane;
                coordLane = lane;
                while (bx >= nbx) {
                    bx -= nbx;
                    by++;
                    if (by >= nby) {
                        by = 0;
                        bz++;
                    }
                }
                if (bx < minBx) {
                    minBx = bx;
                }
                if (bx > maxBx) {
                    maxBx = bx;
                }
                if (by < minBy) {
                    minBy = by;
                }
                if (by > maxBy) {
                    maxBy = by;
                }
                if (bz < minBz) {
                    minBz = bz;
                }
                if (bz > maxBz) {
                    maxBz = bz;
                }
                found = true;
                nonEmpty &= nonEmpty - 1;
            }
        }
        if (onProgress) {
            onProgress(this.types.length, this.types.length);
        }
        return found ? { minBx, minBy, minBz, maxBx, maxBy, maxBz } : null;
    }
    getNavigableBlockBounds(onProgress) {
        const { nbx, nby } = this;
        const totalBlocks = nbx * nby * this.nbz;
        if (totalBlocks === 0) {
            if (onProgress) {
                onProgress(0, 0);
            }
            return null;
        }
        const SOLID_WORD = 0x55555555 >>> 0;
        const lastWordIdx = this.types.length - 1;
        const lastLanes = totalBlocks - lastWordIdx * BLOCKS_PER_WORD;
        const lastNonEmptyMask = lastLanes >= BLOCKS_PER_WORD ? EVEN_BITS : ((((1 << (lastLanes * 2)) - 1) >>> 0) & EVEN_BITS);
        let minBx = nbx, minBy = nby, minBz = this.nbz;
        let maxBx = -1, maxBy = 0, maxBz = 0;
        const PROGRESS_INTERVAL = 1 << 13;
        let nextTick = PROGRESS_INTERVAL;
        for (let w = 0; w < this.types.length; w++) {
            if (onProgress && w >= nextTick) {
                onProgress(w, this.types.length);
                nextTick = w + PROGRESS_INTERVAL;
            }
            const baseIdx = w * BLOCKS_PER_WORD;
            const word = this.types[w];
            const flipped = (word ^ SOLID_WORD) >>> 0;
            let navMask = ((flipped & EVEN_BITS) | ((flipped >>> 1) & EVEN_BITS)) >>> 0;
            if (w === lastWordIdx) {
                navMask &= lastNonEmptyMask;
            }
            let bx = baseIdx % nbx;
            const byBz = (baseIdx / nbx) | 0;
            let by = byBz % nby;
            let bz = (byBz / nby) | 0;
            let coordLane = 0;
            while (navMask) {
                const bp = 31 - Math.clz32(navMask & -navMask);
                const lane = bp >>> 1;
                bx += lane - coordLane;
                coordLane = lane;
                while (bx >= nbx) {
                    bx -= nbx;
                    by++;
                    if (by >= nby) {
                        by = 0;
                        bz++;
                    }
                }
                if (bx < minBx) {
                    minBx = bx;
                }
                if (bx > maxBx) {
                    maxBx = bx;
                }
                if (by < minBy) {
                    minBy = by;
                }
                if (by > maxBy) {
                    maxBy = by;
                }
                if (bz < minBz) {
                    minBz = bz;
                }
                if (bz > maxBz) {
                    maxBz = bz;
                }
                navMask &= navMask - 1;
            }
        }
        if (onProgress) {
            onProgress(this.types.length, this.types.length);
        }
        return maxBx >= 0 ? { minBx, minBy, minBz, maxBx, maxBy, maxBz } : null;
    }
    static findNearestFreeCell(blocked, seedIx, seedIy, seedIz, maxRadius) {
        const { nx, ny, nz } = blocked;
        for (let r = 1; r <= maxRadius; r++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        if (Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) {
                            continue;
                        }
                        const ix = seedIx + dx;
                        const iy = seedIy + dy;
                        const iz = seedIz + dz;
                        if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) {
                            continue;
                        }
                        if (!blocked.getVoxel(ix, iy, iz)) {
                            return { ix, iy, iz };
                        }
                    }
                }
            }
        }
        return null;
    }
}
export const SOLID_LEAF_MARKER = 0xFF000000 >>> 0;
const MAX_24BIT_OFFSET = 0x00FFFFFF;
const DENSE_SOLID_STREAM_THRESHOLD = 8_000_000;
export const getChildOffset = (mask, octant) => {
    const prefix = mask & ((1 << octant) - 1);
    let n = prefix >>> 0;
    n -= ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
};
const bitCount = (n) => {
    let v = n >>> 0;
    v -= ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
};
const sortMixedByMorton = (mortons, masks, n = mortons.length) => {
    if (n <= 1) {
        return;
    }
    const stackLo = [0];
    const stackHi = [n - 1];
    const swap = (a, b) => {
        const km = mortons[a];
        mortons[a] = mortons[b];
        mortons[b] = km;
        const alo = masks[a * 2];
        const ahi = masks[a * 2 + 1];
        masks[a * 2] = masks[b * 2];
        masks[a * 2 + 1] = masks[b * 2 + 1];
        masks[b * 2] = alo;
        masks[b * 2 + 1] = ahi;
    };
    while (stackLo.length > 0) {
        const lo = stackLo.pop();
        const hi = stackHi.pop();
        if (hi - lo < 16) {
            for (let i = lo + 1; i <= hi; i++) {
                const km = mortons[i];
                const m0 = masks[i * 2];
                const m1 = masks[i * 2 + 1];
                let j = i - 1;
                while (j >= lo && mortons[j] > km) {
                    mortons[j + 1] = mortons[j];
                    masks[(j + 1) * 2] = masks[j * 2];
                    masks[(j + 1) * 2 + 1] = masks[j * 2 + 1];
                    j--;
                }
                mortons[j + 1] = km;
                masks[(j + 1) * 2] = m0;
                masks[(j + 1) * 2 + 1] = m1;
            }
            continue;
        }
        const mid = (lo + hi) >>> 1;
        if (mortons[mid] < mortons[lo]) {
            swap(mid, lo);
        }
        if (mortons[hi] < mortons[lo]) {
            swap(hi, lo);
        }
        if (mortons[hi] < mortons[mid]) {
            swap(hi, mid);
        }
        const pivot = mortons[mid];
        let i = lo;
        let j = hi;
        while (i <= j) {
            while (mortons[i] < pivot) {
                i++;
            }
            while (mortons[j] > pivot) {
                j--;
            }
            if (i <= j) {
                if (i !== j) {
                    swap(i, j);
                }
                i++;
                j--;
            }
        }
        if (j - lo > hi - i) {
            if (lo < j) {
                stackLo.push(lo);
                stackHi.push(j);
            }
            if (i < hi) {
                stackLo.push(i);
                stackHi.push(hi);
            }
        }
        else {
            if (i < hi) {
                stackLo.push(i);
                stackHi.push(hi);
            }
            if (lo < j) {
                stackLo.push(lo);
                stackHi.push(j);
            }
        }
    }
};
const createInteriorWave = (initialCapacity) => {
    const cap = Math.max(16, initialCapacity);
    return { pos: new Uint32Array(cap), li: new Uint32Array(cap), ii: new Uint32Array(cap), length: 0 };
};
const pushInteriorWave = (wave, pos, li, ii) => {
    if (wave.length === wave.pos.length) {
        const cap = wave.pos.length * 2;
        const grownPos = new Uint32Array(cap);
        const grownLi = new Uint32Array(cap);
        const grownIi = new Uint32Array(cap);
        grownPos.set(wave.pos);
        grownLi.set(wave.li);
        grownIi.set(wave.ii);
        wave.pos = grownPos;
        wave.li = grownLi;
        wave.ii = grownIi;
    }
    const i = wave.length++;
    wave.pos[i] = pos;
    wave.li[i] = li;
    wave.ii[i] = ii;
};
const shouldUseDenseMipBuild = (totalBlocks, nSolid, nMixed) => {
    return nSolid >= DENSE_SOLID_STREAM_THRESHOLD &&
        nSolid > nMixed * 4 &&
        nSolid > totalBlocks * 0.25;
};
const buildDenseTypeLevels = (grid, maxDepth) => {
    const levels = [{
            types: grid.types,
            nbx: grid.nbx,
            nby: grid.nby,
            nbz: grid.nbz,
            nonEmptyCount: 0
        }];
    for (let li = 1; li <= maxDepth; li++) {
        const prev = levels[li - 1];
        const nbx = Math.max(1, Math.ceil(prev.nbx / 2));
        const nby = Math.max(1, Math.ceil(prev.nby / 2));
        const nbz = Math.max(1, Math.ceil(prev.nbz / 2));
        const total = nbx * nby * nbz;
        const types = new Uint32Array((total + BLOCKS_PER_WORD - 1) >>> 4);
        const prevStride = prev.nbx * prev.nby;
        const stride = nbx * nby;
        let nonEmptyCount = 0;
        for (let pz = 0; pz < nbz; pz++) {
            const childZ0 = pz << 1;
            for (let py = 0; py < nby; py++) {
                const childY0 = py << 1;
                for (let px = 0; px < nbx; px++) {
                    const childX0 = px << 1;
                    let childMask = 0;
                    let allSolid = true;
                    let childCount = 0;
                    for (let oct = 0; oct < 8; oct++) {
                        const cx = childX0 + (oct & 1);
                        const cy = childY0 + ((oct >> 1) & 1);
                        const cz = childZ0 + ((oct >> 2) & 1);
                        if (cx >= prev.nbx || cy >= prev.nby || cz >= prev.nbz) {
                            continue;
                        }
                        const childIdx = cx + cy * prev.nbx + cz * prevStride;
                        const bt = readBlockType(prev.types, childIdx);
                        if (bt === BLOCK_EMPTY) {
                            continue;
                        }
                        childMask |= 1 << oct;
                        childCount++;
                        if (bt !== BLOCK_SOLID) {
                            allSolid = false;
                        }
                    }
                    if (childMask !== 0) {
                        const parentIdx = px + py * nbx + pz * stride;
                        writeBlockType(types, parentIdx, allSolid && childCount === 8 ? BLOCK_SOLID : BLOCK_MIXED);
                        nonEmptyCount++;
                    }
                }
            }
        }
        levels.push({ types, nbx, nby, nbz, nonEmptyCount });
        if (nonEmptyCount === 0) {
            break;
        }
        if (nonEmptyCount === 1 && readBlockType(types, 0) !== BLOCK_EMPTY) {
            break;
        }
    }
    return levels;
};
const lowerBoundF64 = (arr, target, n) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < target) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo;
};
const flattenTreeFromLevels = (interiorLevels, solidStream, mixedStream, mixedMasks, nSolid, nMixed, gridBounds, sceneBounds, voxelResolution, treeDepth) => {
    if (interiorLevels.length === 0) {
        return {
            gridBounds,
            sceneBounds,
            voxelResolution,
            leafSize: LEAF_SIZE,
            treeDepth,
            numInteriorNodes: 0,
            numMixedLeaves: 0,
            nodes: new Uint32Array(0),
            leafData: new Uint32Array(0)
        };
    }
    const rootLevel = interiorLevels[interiorLevels.length - 1];
    let maxNodes = nSolid + nMixed;
    for (let l = 0; l < interiorLevels.length; l++) {
        maxNodes += interiorLevels[l].mortons.length;
    }
    const nodes = new Uint32Array(maxNodes);
    const leafData = new Uint32Array(nMixed * 2);
    let leafDataLen = 0;
    let numInteriorNodes = 0;
    let numMixedLeaves = 0;
    let emitPos = 0;
    let waveLi = [];
    let waveIi = [];
    const rootLi = interiorLevels.length - 1;
    for (let i = 0; i < rootLevel.mortons.length; i++) {
        waveLi.push(rootLi);
        waveIi.push(i);
    }
    const intPos = [];
    const intLi = [];
    const intIi = [];
    const intMask = [];
    while (waveLi.length > 0) {
        intPos.length = 0;
        intLi.length = 0;
        intIi.length = 0;
        intMask.length = 0;
        for (let w = 0; w < waveLi.length; w++) {
            const li = waveLi[w];
            const ii = waveIi[w];
            if (li === -1) {
                if (ii < nMixed) {
                    const leafDataIndex = leafDataLen >> 1;
                    if (leafDataIndex > MAX_24BIT_OFFSET) {
                        throw new Error(`Sparse octree mixed-leaf count (${leafDataIndex + 1}) exceeds the Laine-Karras 24-bit baseOffset limit (${MAX_24BIT_OFFSET + 1}). Reduce the grid size or split the scene.`);
                    }
                    leafData[leafDataLen++] = mixedMasks[ii * 2];
                    leafData[leafDataLen++] = mixedMasks[ii * 2 + 1];
                    nodes[emitPos] = leafDataIndex;
                    numMixedLeaves++;
                }
                else {
                    nodes[emitPos] = SOLID_LEAF_MARKER;
                }
                emitPos++;
                continue;
            }
            const level = interiorLevels[li];
            const type = level.types[ii];
            if (type === 1 /* OctreeNodeType.Solid */) {
                nodes[emitPos] = SOLID_LEAF_MARKER;
            }
            else {
                intPos.push(emitPos);
                intLi.push(li);
                intIi.push(ii);
                intMask.push(level.childMasks[ii]);
                numInteriorNodes++;
                nodes[emitPos] = 0;
            }
            emitPos++;
        }
        const nextWaveLi = [];
        const nextWaveIi = [];
        let nextChildStart = emitPos;
        for (let j = 0; j < intPos.length; j++) {
            const childMask = intMask[j];
            const childCount = bitCount(childMask);
            if (nextChildStart > MAX_24BIT_OFFSET) {
                throw new Error(`Sparse octree node count (${nextChildStart + 1}) exceeds the Laine-Karras 24-bit baseOffset limit (${MAX_24BIT_OFFSET + 1}). Reduce the grid size or split the scene.`);
            }
            nodes[intPos[j]] = ((childMask & 0xFF) << 24) | nextChildStart;
            const myLi = intLi[j];
            const myMorton = interiorLevels[myLi].mortons[intIi[j]];
            const childMortonBase = myMorton * 8;
            const childMortonEnd = childMortonBase + 8;
            if (myLi === 0) {
                let sIdx = lowerBoundF64(solidStream, childMortonBase, nSolid);
                let mIdx = lowerBoundF64(mixedStream, childMortonBase, nMixed);
                while (true) {
                    const sM = sIdx < nSolid && solidStream[sIdx] < childMortonEnd ? solidStream[sIdx] : Number.POSITIVE_INFINITY;
                    const mM = mIdx < nMixed && mixedStream[mIdx] < childMortonEnd ? mixedStream[mIdx] : Number.POSITIVE_INFINITY;
                    if (!isFinite(sM) && !isFinite(mM)) {
                        break;
                    }
                    if (sM < mM) {
                        nextWaveLi.push(-1);
                        nextWaveIi.push(nMixed + sIdx);
                        sIdx++;
                    }
                    else {
                        nextWaveLi.push(-1);
                        nextWaveIi.push(mIdx);
                        mIdx++;
                    }
                }
            }
            else {
                const childLi = myLi - 1;
                const childLevel = interiorLevels[childLi];
                const childMortons = childLevel.mortons;
                let lo = 0;
                let hi = childMortons.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (childMortons[mid] < childMortonBase) {
                        lo = mid + 1;
                    }
                    else {
                        hi = mid;
                    }
                }
                while (lo < childMortons.length && childMortons[lo] < childMortonEnd) {
                    nextWaveLi.push(childLi);
                    nextWaveIi.push(lo);
                    lo++;
                }
            }
            nextChildStart += childCount;
        }
        waveLi = nextWaveLi;
        waveIi = nextWaveIi;
    }
    return {
        gridBounds,
        sceneBounds,
        voxelResolution,
        leafSize: LEAF_SIZE,
        treeDepth,
        numInteriorNodes,
        numMixedLeaves,
        nodes: emitPos === maxNodes ? nodes : nodes.slice(0, emitPos),
        leafData: leafDataLen === leafData.length ? leafData : leafData.slice(0, leafDataLen)
    };
};
const flattenDenseLevels = (levels, grid, gridBounds, sceneBounds, voxelResolution) => {
    const treeDepth = Math.max(1, levels.length - 1);
    const rootLi = levels.length - 1;
    const rootLevel = levels[rootLi];
    const rootType = readBlockType(rootLevel.types, 0);
    if (rootType === BLOCK_EMPTY) {
        return {
            gridBounds, sceneBounds, voxelResolution, leafSize: LEAF_SIZE, treeDepth,
            numInteriorNodes: 0, numMixedLeaves: 0, nodes: new Uint32Array(0), leafData: new Uint32Array(0)
        };
    }
    let nodes = new Uint32Array(Math.max(1024, Math.min(MAX_24BIT_OFFSET + 1, grid.masks.size * 3)));
    let nodeLen = 0;
    let leafData = new Uint32Array(Math.max(1024, grid.masks.size * 2));
    let leafDataLen = 0;
    let numInteriorNodes = 0;
    let numMixedLeaves = 0;
    const appendNode = (value) => {
        if (nodeLen === nodes.length) {
            const grown = new Uint32Array(nodes.length * 2);
            grown.set(nodes);
            nodes = grown;
        }
        nodes[nodeLen] = value >>> 0;
        return nodeLen++;
    };
    const appendMixedLeaf = (blockIdx) => {
        const leafDataIndex = leafDataLen >> 1;
        if (leafDataIndex > MAX_24BIT_OFFSET) {
            throw new Error(`Sparse octree mixed-leaf count (${leafDataIndex + 1}) exceeds the Laine-Karras 24-bit baseOffset limit (${MAX_24BIT_OFFSET + 1}). Reduce the grid size or split the scene.`);
        }
        if (leafDataLen + 2 > leafData.length) {
            const grown = new Uint32Array(leafData.length * 2);
            grown.set(leafData);
            leafData = grown;
        }
        const s = grid.masks.slot(blockIdx);
        leafData[leafDataLen++] = grid.masks.lo[s];
        leafData[leafDataLen++] = grid.masks.hi[s];
        appendNode(leafDataIndex);
        numMixedLeaves++;
    };
    let curWave = createInteriorWave(1);
    let nextWave = createInteriorWave(1024);
    const appendDenseNode = (li, idx, wave) => {
        const level = levels[li];
        const bt = readBlockType(level.types, idx);
        if (bt === BLOCK_SOLID) {
            appendNode(SOLID_LEAF_MARKER);
        }
        else if (bt === BLOCK_MIXED) {
            const pos = appendNode(0);
            pushInteriorWave(wave, pos, li, idx);
            numInteriorNodes++;
        }
    };
    appendDenseNode(rootLi, 0, curWave);
    while (curWave.length > 0) {
        nextWave.length = 0;
        const currentLi = curWave.li[0];
        for (let w = 0; w < curWave.length; w++) {
            const li = curWave.li[w];
            const parentLevel = levels[li];
            const childLevel = levels[li - 1];
            const parentIdx = curWave.ii[w];
            const px = parentIdx % parentLevel.nbx;
            const pyBz = (parentIdx / parentLevel.nbx) | 0;
            const py = pyBz % parentLevel.nby;
            const pz = (pyBz / parentLevel.nby) | 0;
            const childX0 = px << 1;
            const childY0 = py << 1;
            const childZ0 = pz << 1;
            const childStride = childLevel.nbx * childLevel.nby;
            const childStart = nodeLen;
            let childMask = 0;
            if (childStart > MAX_24BIT_OFFSET) {
                throw new Error(`Sparse octree node count (${childStart + 1}) exceeds the Laine-Karras 24-bit baseOffset limit (${MAX_24BIT_OFFSET + 1}). Reduce the grid size or split the scene.`);
            }
            for (let oct = 0; oct < 8; oct++) {
                const cx = childX0 + (oct & 1);
                const cy = childY0 + ((oct >> 1) & 1);
                const cz = childZ0 + ((oct >> 2) & 1);
                if (cx >= childLevel.nbx || cy >= childLevel.nby || cz >= childLevel.nbz) {
                    continue;
                }
                const childIdx = cx + cy * childLevel.nbx + cz * childStride;
                const bt = readBlockType(childLevel.types, childIdx);
                if (bt === BLOCK_EMPTY) {
                    continue;
                }
                childMask |= 1 << oct;
                if (li === 1) {
                    if (bt === BLOCK_SOLID) {
                        appendNode(SOLID_LEAF_MARKER);
                    }
                    else {
                        appendMixedLeaf(childIdx);
                    }
                }
                else {
                    appendDenseNode(li - 1, childIdx, nextWave);
                }
            }
            nodes[curWave.pos[w]] = ((childMask & 0xFF) << 24) | childStart;
        }
        levels[currentLi] = null;
        const tmp = curWave;
        curWave = nextWave;
        nextWave = tmp;
    }
    return {
        gridBounds,
        sceneBounds,
        voxelResolution,
        leafSize: LEAF_SIZE,
        treeDepth,
        numInteriorNodes,
        numMixedLeaves,
        nodes: nodes.slice(0, nodeLen),
        leafData: leafData.slice(0, leafDataLen)
    };
};
const buildSparseOctreeDense = (grid, gridBounds, sceneBounds, voxelResolution, maxDepth, consumeGrid) => {
    const levels = buildDenseTypeLevels(grid, maxDepth);
    const result = flattenDenseLevels(levels, grid, gridBounds, sceneBounds, voxelResolution);
    if (consumeGrid) {
        grid.releaseStorage();
    }
    return result;
};
/**
 * Build a sparse octree from block masks using:
 * 1) mixed+solid SoA merge and Morton sort
 * 2) bottom-up level construction by parent Morton grouping
 * 3) BFS flatten to node/leafData arrays.
 */
export const buildSparseOctree = (grid, gridBounds, sceneBounds, voxelResolution, options = {}) => {
    const { nbx, nby, nbz, types: gridTypes, masks: gridMasks } = grid;
    const totalBlocks = nbx * nby * nbz;
    const blocksPerAxis = Math.max(nbx, nby, nbz);
    const treeDepth = Math.max(1, Math.ceil(Math.log2(blocksPerAxis)));
    const lastWordIdx = gridTypes.length - 1;
    const lastLanes = totalBlocks - lastWordIdx * BLOCKS_PER_WORD;
    const lastValidWordMask = lastLanes >= BLOCKS_PER_WORD ? 0xFFFFFFFF >>> 0 : ((1 << (lastLanes * 2)) - 1) >>> 0;
    let nSolid = 0;
    let nMixed = 0;
    for (let w = 0; w < gridTypes.length; w++) {
        let word = gridTypes[w];
        if (w === lastWordIdx) {
            word = (word & lastValidWordMask) >>> 0;
        }
        if (word === 0) {
            continue;
        }
        const solidMask = (word & EVEN_BITS) & ~((word >>> 1) & EVEN_BITS);
        const mixedMask = ((word >>> 1) & EVEN_BITS) & ~(word & EVEN_BITS);
        nSolid += bitCount(solidMask >>> 0);
        nMixed += bitCount(mixedMask >>> 0);
    }
    if (nSolid + nMixed === 0) {
        return {
            gridBounds,
            sceneBounds,
            voxelResolution,
            leafSize: LEAF_SIZE,
            treeDepth: 1,
            numInteriorNodes: 0,
            numMixedLeaves: 0,
            nodes: new Uint32Array(0),
            leafData: new Uint32Array(0)
        };
    }
    if (options.dense || shouldUseDenseMipBuild(totalBlocks, nSolid, nMixed)) {
        return buildSparseOctreeDense(grid, gridBounds, sceneBounds, voxelResolution, treeDepth, !!options.consumeGrid);
    }
    const solidStream = new Float64Array(nSolid);
    const mixedStream = new Float64Array(nMixed);
    const mixedMasks = new Uint32Array(nMixed * 2);
    let solidWriteIdx = 0;
    let mixedWriteIdx = 0;
    for (let w = 0; w < gridTypes.length; w++) {
        let word = gridTypes[w];
        if (w === lastWordIdx) {
            word = (word & lastValidWordMask) >>> 0;
        }
        if (word === 0) {
            continue;
        }
        let nonEmpty = ((word & EVEN_BITS) | ((word >>> 1) & EVEN_BITS)) >>> 0;
        const baseIdx = w * BLOCKS_PER_WORD;
        while (nonEmpty) {
            const bp = 31 - Math.clz32(nonEmpty & -nonEmpty);
            const lane = bp >>> 1;
            nonEmpty &= nonEmpty - 1;
            const blockIdx = baseIdx + lane;
            if (blockIdx >= totalBlocks) {
                break;
            }
            const bx = blockIdx % nbx;
            const byBz = (blockIdx / nbx) | 0;
            const by = byBz % nby;
            const bz = (byBz / nby) | 0;
            const morton = encodeMorton3(bx, by, bz);
            const bt = (word >>> (lane << 1)) & TYPE_MASK;
            if (bt === 1 /* OctreeNodeType.Solid */) {
                solidStream[solidWriteIdx++] = morton;
            }
            else if (bt === 2 /* OctreeNodeType.Mixed */) {
                mixedStream[mixedWriteIdx] = morton;
                const s = gridMasks.slot(blockIdx);
                mixedMasks[mixedWriteIdx * 2] = gridMasks.lo[s];
                mixedMasks[mixedWriteIdx * 2 + 1] = gridMasks.hi[s];
                mixedWriteIdx++;
            }
        }
    }
    if (options.consumeGrid) {
        grid.releaseStorage();
    }
    if (nSolid > 1) {
        solidStream.sort();
    }
    if (nMixed > 1) {
        sortMixedByMorton(mixedStream, mixedMasks, nMixed);
    }
    const interiorLevels = [];
    let curMortons = [];
    let curTypes = [];
    let curChildMasks = [];
    {
        let sI = 0;
        let mI = 0;
        while (sI < nSolid || mI < nMixed) {
            const sM0 = sI < nSolid ? solidStream[sI] : Number.POSITIVE_INFINITY;
            const mM0 = mI < nMixed ? mixedStream[mI] : Number.POSITIVE_INFINITY;
            const minMorton = sM0 < mM0 ? sM0 : mM0;
            const parentMorton = Math.floor(minMorton / 8);
            let childMask = 0;
            let allSolid = true;
            let childCount = 0;
            while (true) {
                const sM = sI < nSolid ? solidStream[sI] : Number.POSITIVE_INFINITY;
                const mM = mI < nMixed ? mixedStream[mI] : Number.POSITIVE_INFINITY;
                const cur = sM < mM ? sM : mM;
                if (!isFinite(cur) || Math.floor(cur / 8) !== parentMorton) {
                    break;
                }
                childMask |= 1 << (cur % 8);
                childCount++;
                if (sM < mM) {
                    sI++;
                }
                else {
                    allSolid = false;
                    mI++;
                }
            }
            curMortons.push(parentMorton);
            if (allSolid && childCount === 8) {
                curTypes.push(1 /* OctreeNodeType.Solid */);
                curChildMasks.push(0);
            }
            else {
                curTypes.push(2 /* OctreeNodeType.Mixed */);
                curChildMasks.push(childMask);
            }
        }
    }
    let actualDepth = treeDepth;
    if (curMortons.length === 0) {
        actualDepth = 1;
    }
    else if (curMortons.length === 1 && curMortons[0] === 0) {
        actualDepth = 1;
        interiorLevels.push({ mortons: curMortons, types: curTypes, childMasks: curChildMasks });
    }
    else {
        for (let level = 1; level < treeDepth; level++) {
            interiorLevels.push({ mortons: curMortons, types: curTypes, childMasks: curChildMasks });
            const n = curMortons.length;
            const nextMortons = [];
            const nextTypes = [];
            const nextChildMasks = [];
            let i = 0;
            while (i < n) {
                const parentMorton = Math.floor(curMortons[i] / 8);
                let childMask = 0;
                let allSolid = true;
                let childCount = 0;
                while (i < n && Math.floor(curMortons[i] / 8) === parentMorton) {
                    const octant = curMortons[i] % 8;
                    childMask |= (1 << octant);
                    if (curTypes[i] !== 1 /* OctreeNodeType.Solid */) {
                        allSolid = false;
                    }
                    childCount++;
                    i++;
                }
                nextMortons.push(parentMorton);
                if (allSolid && childCount === 8) {
                    nextTypes.push(1 /* OctreeNodeType.Solid */);
                    nextChildMasks.push(0);
                }
                else {
                    nextTypes.push(2 /* OctreeNodeType.Mixed */);
                    nextChildMasks.push(childMask);
                }
            }
            curMortons = nextMortons;
            curTypes = nextTypes;
            curChildMasks = nextChildMasks;
            if (curMortons.length === 1 && curMortons[0] === 0) {
                actualDepth = level + 1;
                break;
            }
        }
        interiorLevels.push({ mortons: curMortons, types: curTypes, childMasks: curChildMasks });
    }
    return flattenTreeFromLevels(interiorLevels, solidStream, mixedStream, mixedMasks, nSolid, nMixed, gridBounds, sceneBounds, voxelResolution, actualDepth);
};
export { BLOCK_EMPTY, BLOCK_SOLID, BLOCK_MIXED, BLOCKS_PER_WORD, TYPE_MASK, EVEN_BITS, readBlockType, writeBlockType, SOLID_LO, SOLID_HI, SparseVoxelGrid };
