import { BLOCK_EMPTY, BLOCK_SOLID, BLOCK_MIXED, SOLID_LO, SOLID_HI, SparseVoxelGrid, readBlockType, writeBlockType } from './common.js';
import { gpuDilate3 } from './gpu-dilation.js';
import { logger } from '../Logger.js';
const FACE_MASKS_LO = [
    0x11111111 >>> 0, // -X
    0x88888888 >>> 0, // +X
    0x000F000F >>> 0, // -Y
    0xF000F000 >>> 0, // +Y
    0x0000FFFF >>> 0, // -Z
    0x00000000 >>> 0, // +Z
];
const FACE_MASKS_HI = [
    0x11111111 >>> 0,
    0x88888888 >>> 0,
    0x000F000F >>> 0,
    0xF000F000 >>> 0,
    0x00000000 >>> 0,
    0xFFFF0000 >>> 0,
];
const forEachNonEmptyBlock = (grid, fn) => {
    const totalBlocks = grid.nbx * grid.nby * grid.nbz;
    for (let w = 0; w < grid.types.length; w++) {
        let nonEmpty = ((grid.types[w] & 0x55555555) | ((grid.types[w] >>> 1) & 0x55555555)) >>> 0;
        const baseIdx = w * 16;
        while (nonEmpty) {
            const bitPos = 31 - Math.clz32(nonEmpty & -nonEmpty);
            const blockIdx = baseIdx + (bitPos >>> 1);
            if (blockIdx >= totalBlocks) {
                break;
            }
            fn(blockIdx);
            nonEmpty &= nonEmpty - 1;
        }
    }
};
// Active block-pair extraction for separable dilation passes.
function getActiveYZPairs(grid) {
    const pairs = new Set();
    const { nbx } = grid;
    forEachNonEmptyBlock(grid, (blockIdx) => pairs.add((blockIdx / nbx) | 0));
    return pairs;
}
function getActiveXZPairs(grid) {
    const pairs = new Set();
    const { nbx, bStride } = grid;
    forEachNonEmptyBlock(grid, (blockIdx) => {
        const bx = blockIdx % nbx;
        const bz = (blockIdx / bStride) | 0;
        pairs.add(bx + bz * nbx);
    });
    return pairs;
}
function getActiveXYPairs(grid) {
    const pairs = new Set();
    const { nbx, nby } = grid;
    forEachNonEmptyBlock(grid, (blockIdx) => {
        const bx = blockIdx % nbx;
        const by = ((blockIdx / nbx) | 0) % nby;
        pairs.add(bx + by * nbx);
    });
    return pairs;
}
// Line extraction/writeback helpers between sparse block masks and bit-packed 1D buffers.
function extractLineX(grid, iy, iz, buf) {
    const by = iy >> 2, bz = iz >> 2;
    const bitBase = ((iz & 3) << 4) + ((iy & 3) << 2);
    const inHi = bitBase >= 32;
    const shift = inHi ? bitBase - 32 : bitBase;
    const lineBase = by * grid.nbx + bz * grid.bStride;
    for (let bx = 0; bx < grid.nbx; bx++) {
        const blockIdx = lineBase + bx;
        const bt = readBlockType(grid.types, blockIdx);
        if (bt === BLOCK_EMPTY) {
            continue;
        }
        let row4;
        if (bt === BLOCK_SOLID) {
            row4 = 0xF;
        }
        else {
            const s = grid.masks.slot(blockIdx);
            row4 = ((inHi ? grid.masks.hi[s] : grid.masks.lo[s]) >>> shift) & 0xF;
        }
        if (row4) {
            const ix = bx << 2;
            buf[ix >>> 5] |= (row4 << (ix & 31));
        }
    }
}
function writeLineX(grid, iy, iz, buf) {
    const by = iy >> 2, bz = iz >> 2;
    const bitBase = ((iz & 3) << 4) + ((iy & 3) << 2);
    const inHi = bitBase >= 32;
    const shift = inHi ? bitBase - 32 : bitBase;
    const lineBase = by * grid.nbx + bz * grid.bStride;
    for (let bx = 0; bx < grid.nbx; bx++) {
        const ix = bx << 2;
        const row4 = (buf[ix >>> 5] >>> (ix & 31)) & 0xF;
        if (!row4) {
            continue;
        }
        const blockIdx = lineBase + bx;
        grid.orBlock(blockIdx, inHi ? 0 : (row4 << shift) >>> 0, inHi ? (row4 << shift) >>> 0 : 0);
    }
}
function extractLineY(grid, ix, iz, buf) {
    const bx = ix >> 2, bz = iz >> 2;
    const lx = ix & 3, lz = iz & 3;
    const inHi = lz >= 2;
    const base = lx + (lz & 1) * 16;
    for (let by = 0; by < grid.nby; by++) {
        const blockIdx = bx + by * grid.nbx + bz * grid.bStride;
        const bt = readBlockType(grid.types, blockIdx);
        if (bt === BLOCK_EMPTY) {
            continue;
        }
        let row4;
        if (bt === BLOCK_SOLID) {
            row4 = 0xF;
        }
        else {
            const s = grid.masks.slot(blockIdx);
            const word = inHi ? grid.masks.hi[s] : grid.masks.lo[s];
            row4 = ((word >>> base) & 1) | (((word >>> (base + 4)) & 1) << 1) | (((word >>> (base + 8)) & 1) << 2) | (((word >>> (base + 12)) & 1) << 3);
        }
        if (row4) {
            const iy = by << 2;
            buf[iy >>> 5] |= (row4 << (iy & 31));
        }
    }
}
function writeLineY(grid, ix, iz, buf) {
    const bx = ix >> 2, bz = iz >> 2;
    const lx = ix & 3, lz = iz & 3;
    const inHi = lz >= 2;
    const base = lx + (lz & 1) * 16;
    for (let by = 0; by < grid.nby; by++) {
        const iy = by << 2;
        const row4 = (buf[iy >>> 5] >>> (iy & 31)) & 0xF;
        if (!row4) {
            continue;
        }
        const blockIdx = bx + by * grid.nbx + bz * grid.bStride;
        const bits = ((row4 & 1) << base) | (((row4 >>> 1) & 1) << (base + 4)) | (((row4 >>> 2) & 1) << (base + 8)) | (((row4 >>> 3) & 1) << (base + 12));
        grid.orBlock(blockIdx, inHi ? 0 : bits >>> 0, inHi ? bits >>> 0 : 0);
    }
}
function extractLineZ(grid, ix, iy, buf) {
    const bx = ix >> 2, by = iy >> 2;
    const base = (ix & 3) + ((iy & 3) << 2);
    for (let bz = 0; bz < grid.nbz; bz++) {
        const blockIdx = bx + by * grid.nbx + bz * grid.bStride;
        const bt = readBlockType(grid.types, blockIdx);
        if (bt === BLOCK_EMPTY) {
            continue;
        }
        let row4;
        if (bt === BLOCK_SOLID) {
            row4 = 0xF;
        }
        else {
            const s = grid.masks.slot(blockIdx);
            row4 = ((grid.masks.lo[s] >>> base) & 1) | (((grid.masks.lo[s] >>> (base + 16)) & 1) << 1) | (((grid.masks.hi[s] >>> base) & 1) << 2) | (((grid.masks.hi[s] >>> (base + 16)) & 1) << 3);
        }
        if (row4) {
            const iz = bz << 2;
            buf[iz >>> 5] |= (row4 << (iz & 31));
        }
    }
}
function writeLineZ(grid, ix, iy, buf) {
    const bx = ix >> 2, by = iy >> 2;
    const base = (ix & 3) + ((iy & 3) << 2);
    for (let bz = 0; bz < grid.nbz; bz++) {
        const iz = bz << 2;
        const row4 = (buf[iz >>> 5] >>> (iz & 31)) & 0xF;
        if (!row4) {
            continue;
        }
        const blockIdx = bx + by * grid.nbx + bz * grid.bStride;
        let lo = 0, hi = 0;
        if (row4 & 1) {
            lo |= (1 << base);
        }
        if (row4 & 2) {
            lo |= (1 << (base + 16));
        }
        if (row4 & 4) {
            hi |= (1 << base);
        }
        if (row4 & 8) {
            hi |= (1 << (base + 16));
        }
        grid.orBlock(blockIdx, lo >>> 0, hi >>> 0);
    }
}
/**
 * 1D binary dilation with a flat window using a sliding count.
 * A destination bit is set if any source bit is set within +/- halfExtent.
 */
function flatDilate1D(src, dst, n, halfExtent) {
    let count = 0;
    const winEnd = Math.min(halfExtent, n - 1);
    for (let i = 0; i <= winEnd; i++) {
        if ((src[i >>> 5] >>> (i & 31)) & 1) {
            count++;
        }
    }
    for (let i = 0; i < n; i++) {
        if (count > 0) {
            dst[i >>> 5] |= (1 << (i & 31));
        }
        const exitI = i - halfExtent;
        if (exitI >= 0 && ((src[exitI >>> 5] >>> (exitI & 31)) & 1)) {
            count--;
        }
        const enterI = i + halfExtent + 1;
        if (enterI < n && ((src[enterI >>> 5] >>> (enterI & 31)) & 1)) {
            count++;
        }
    }
}
/**
 * Dilate along X by extracting X-lines from sparse blocks, dilating each line,
 * then writing back into destination blocks.
 */
function sparseDilateX(src, dst, halfExtent) {
    const { nx, ny, nz, nbx, nby, bStride } = src;
    const lineWords = (nx + 31) >>> 5;
    const srcBuf = new Uint32Array(lineWords);
    const dstBuf = new Uint32Array(lineWords);
    const activePairs = getActiveYZPairs(src);
    for (const key of activePairs) {
        const by = key % nby;
        const bz = (key / nby) | 0;
        const lineBase = by * nbx + bz * bStride;
        let allSolid = true;
        for (let bx = 0; bx < nbx; bx++) {
            if (readBlockType(src.types, lineBase + bx) !== BLOCK_SOLID) {
                allSolid = false;
                break;
            }
        }
        if (allSolid) {
            for (let bx = 0; bx < nbx; bx++) {
                dst.orBlock(lineBase + bx, SOLID_LO, SOLID_HI);
            }
            continue;
        }
        for (let ly = 0; ly < 4; ly++) {
            const iy = (by << 2) + ly;
            if (iy >= ny) {
                continue;
            }
            for (let lz = 0; lz < 4; lz++) {
                const iz = (bz << 2) + lz;
                if (iz >= nz) {
                    continue;
                }
                srcBuf.fill(0);
                dstBuf.fill(0);
                extractLineX(src, iy, iz, srcBuf);
                flatDilate1D(srcBuf, dstBuf, nx, halfExtent);
                writeLineX(dst, iy, iz, dstBuf);
            }
        }
    }
}
/**
 * Dilate along Y by extracting Y-lines from sparse blocks.
 */
function sparseDilateY(src, dst, halfExtent) {
    const { nx, ny, nz, nbx, nby, bStride } = src;
    const lineWords = (ny + 31) >>> 5;
    const srcBuf = new Uint32Array(lineWords);
    const dstBuf = new Uint32Array(lineWords);
    const activePairs = getActiveXZPairs(src);
    for (const key of activePairs) {
        const bx = key % nbx;
        const bz = (key / nbx) | 0;
        const lineStart = bx + bz * bStride;
        let allSolid = true;
        for (let by = 0; by < nby; by++) {
            if (readBlockType(src.types, lineStart + by * nbx) !== BLOCK_SOLID) {
                allSolid = false;
                break;
            }
        }
        if (allSolid) {
            for (let by = 0; by < nby; by++) {
                dst.orBlock(lineStart + by * nbx, SOLID_LO, SOLID_HI);
            }
            continue;
        }
        for (let lx = 0; lx < 4; lx++) {
            const ix = (bx << 2) + lx;
            if (ix >= nx) {
                continue;
            }
            for (let lz = 0; lz < 4; lz++) {
                const iz = (bz << 2) + lz;
                if (iz >= nz) {
                    continue;
                }
                srcBuf.fill(0);
                dstBuf.fill(0);
                extractLineY(src, ix, iz, srcBuf);
                flatDilate1D(srcBuf, dstBuf, ny, halfExtent);
                writeLineY(dst, ix, iz, dstBuf);
            }
        }
    }
}
/**
 * Dilate along Z by extracting Z-lines from sparse blocks.
 */
function sparseDilateZ(src, dst, halfExtent) {
    const { nx, ny, nz, nbx, nbz, bStride } = src;
    const lineWords = (nz + 31) >>> 5;
    const srcBuf = new Uint32Array(lineWords);
    const dstBuf = new Uint32Array(lineWords);
    const activePairs = getActiveXYPairs(src);
    for (const key of activePairs) {
        const bx = key % nbx;
        const by = (key / nbx) | 0;
        const lineStart = bx + by * nbx;
        let allSolid = true;
        for (let bz = 0; bz < nbz; bz++) {
            if (readBlockType(src.types, lineStart + bz * bStride) !== BLOCK_SOLID) {
                allSolid = false;
                break;
            }
        }
        if (allSolid) {
            for (let bz = 0; bz < nbz; bz++) {
                dst.orBlock(lineStart + bz * bStride, SOLID_LO, SOLID_HI);
            }
            continue;
        }
        for (let lx = 0; lx < 4; lx++) {
            const ix = (bx << 2) + lx;
            if (ix >= nx) {
                continue;
            }
            for (let ly = 0; ly < 4; ly++) {
                const iy = (by << 2) + ly;
                if (iy >= ny) {
                    continue;
                }
                srcBuf.fill(0);
                dstBuf.fill(0);
                extractLineZ(src, ix, iy, srcBuf);
                flatDilate1D(srcBuf, dstBuf, nz, halfExtent);
                writeLineZ(dst, ix, iy, dstBuf);
            }
        }
    }
}
/**
 * Separable 3D dilation: X pass, then Z pass, then Y pass.
 * X/Z share radius while Y can use a different half extent.
 */
function sparseDilate3(src, halfExtentXZ, halfExtentY) {
    const a = new SparseVoxelGrid(src.nx, src.ny, src.nz);
    sparseDilateX(src, a, halfExtentXZ);
    const b = new SparseVoxelGrid(src.nx, src.ny, src.nz);
    sparseDilateZ(a, b, halfExtentXZ);
    a.clear();
    sparseDilateY(b, a, halfExtentY);
    b.clear();
    return a;
}
const dilate3 = async (src, halfExtentXZ, halfExtentY, backend) => (backend === 'gpu'
    ? gpuDilate3(src, halfExtentXZ, halfExtentY)
    : sparseDilate3(src, halfExtentXZ, halfExtentY));
/**
 * Compute reachable empty voxels as visited \ blocked.
 * This keeps only flood-filled cells that are not blocked after dilation.
 */
function computeEmptyGrid(visited, blocked) {
    const empty = new SparseVoxelGrid(visited.nx, visited.ny, visited.nz);
    forEachNonEmptyBlock(visited, (blockIdx) => {
        const vbt = readBlockType(visited.types, blockIdx);
        let vLo, vHi;
        if (vbt === BLOCK_SOLID) {
            vLo = SOLID_LO;
            vHi = SOLID_HI;
        }
        else {
            const vs = visited.masks.slot(blockIdx);
            vLo = visited.masks.lo[vs];
            vHi = visited.masks.hi[vs];
        }
        const bbt = readBlockType(blocked.types, blockIdx);
        let lo, hi;
        if (bbt === BLOCK_EMPTY) {
            lo = vLo;
            hi = vHi;
        }
        else if (bbt === BLOCK_SOLID) {
            lo = 0;
            hi = 0;
        }
        else {
            const bs = blocked.masks.slot(blockIdx);
            lo = (vLo & ~blocked.masks.lo[bs]) >>> 0;
            hi = (vHi & ~blocked.masks.hi[bs]) >>> 0;
        }
        if (lo || hi) {
            empty.orBlock(blockIdx, lo, hi);
        }
    });
    return empty;
}
/**
 * Sparse OR between two voxel grids (block masks are OR-combined).
 */
function sparseOrGrids(a, b, consumeA = false) {
    const result = consumeA ? a : a.clone();
    forEachNonEmptyBlock(b, (blockIdx) => {
        const bt = readBlockType(b.types, blockIdx);
        if (bt === BLOCK_SOLID) {
            result.orBlock(blockIdx, SOLID_LO, SOLID_HI);
        }
        else {
            const s = b.masks.slot(blockIdx);
            result.orBlock(blockIdx, b.masks.lo[s], b.masks.hi[s]);
        }
    });
    return result;
}
/**
 * Flood fill on sparse voxel grids using two coupled queues:
 * - block queue for fully empty blocks
 * - voxel queue for mixed blocks
 * This mirrors the reference two-level BFS for performance on sparse data.
 */
function twoLevelBFS(blocked, blockSeeds, voxelSeeds, nx, ny, nz) {
    const visited = new SparseVoxelGrid(nx, ny, nz);
    const nbx = nx >> 2;
    const nby = ny >> 2;
    const nbz = nz >> 2;
    const bStride = nbx * nby;
    const bMasks = blocked.masks;
    const vMasks = visited.masks;
    let bqCap = 1 << 14;
    let bqBuf = new Uint32Array(bqCap);
    let bqMask = bqCap - 1, bqHead = 0, bqTail = 0, bqSize = 0;
    let vqCap = 1 << 14;
    let vqIx = new Uint32Array(vqCap);
    let vqIy = new Uint32Array(vqCap);
    let vqIz = new Uint32Array(vqCap);
    let vqMask = vqCap - 1, vqHead = 0, vqTail = 0, vqSize = 0;
    const growBlockQueue = () => {
        const newCap = bqCap << 1;
        const nb = new Uint32Array(newCap);
        for (let i = 0; i < bqSize; i++) {
            nb[i] = bqBuf[(bqHead + i) & bqMask];
        }
        bqBuf = nb;
        bqCap = newCap;
        bqMask = newCap - 1;
        bqHead = 0;
        bqTail = bqSize;
    };
    const growVoxelQueue = () => {
        const newCap = vqCap << 1;
        const nix = new Uint32Array(newCap);
        const niy = new Uint32Array(newCap);
        const niz = new Uint32Array(newCap);
        for (let i = 0; i < vqSize; i++) {
            const j = (vqHead + i) & vqMask;
            nix[i] = vqIx[j];
            niy[i] = vqIy[j];
            niz[i] = vqIz[j];
        }
        vqIx = nix;
        vqIy = niy;
        vqIz = niz;
        vqCap = newCap;
        vqMask = newCap - 1;
        vqHead = 0;
        vqTail = vqSize;
    };
    const enqueueVoxel = (ix, iy, iz) => {
        if (vqSize >= vqCap) {
            growVoxelQueue();
        }
        vqIx[vqTail] = ix;
        vqIy[vqTail] = iy;
        vqIz[vqTail] = iz;
        vqTail = (vqTail + 1) & vqMask;
        vqSize++;
    };
    const tryFillBlock = (blockIdx) => {
        if (readBlockType(blocked.types, blockIdx) !== BLOCK_EMPTY) {
            return false;
        }
        if (readBlockType(visited.types, blockIdx) !== BLOCK_EMPTY) {
            return false;
        }
        writeBlockType(visited.types, blockIdx, BLOCK_SOLID);
        if (bqSize >= bqCap) {
            growBlockQueue();
        }
        bqBuf[bqTail] = blockIdx;
        bqTail = (bqTail + 1) & bqMask;
        bqSize++;
        return true;
    };
    const enqueueFaceVoxels = (nBlockIdx, face, nBx, nBy, nBz) => {
        const vbt = readBlockType(visited.types, nBlockIdx);
        if (vbt === BLOCK_SOLID) {
            return;
        }
        const bs = bMasks.slot(nBlockIdx);
        let vLo = 0, vHi = 0, vs = -1;
        if (vbt === BLOCK_MIXED) {
            vs = vMasks.slot(nBlockIdx);
            vLo = vMasks.lo[vs];
            vHi = vMasks.hi[vs];
        }
        const freeLo = (FACE_MASKS_LO[face] & ~bMasks.lo[bs] & ~vLo) >>> 0;
        const freeHi = (FACE_MASKS_HI[face] & ~bMasks.hi[bs] & ~vHi) >>> 0;
        if (freeLo === 0 && freeHi === 0) {
            return;
        }
        if (vbt === BLOCK_EMPTY) {
            writeBlockType(visited.types, nBlockIdx, BLOCK_MIXED);
            vMasks.set(nBlockIdx, freeLo, freeHi);
        }
        else {
            vMasks.lo[vs] = (vMasks.lo[vs] | freeLo) >>> 0;
            vMasks.hi[vs] = (vMasks.hi[vs] | freeHi) >>> 0;
            if (vMasks.lo[vs] === SOLID_LO && vMasks.hi[vs] === SOLID_HI) {
                vMasks.removeAt(vs);
                writeBlockType(visited.types, nBlockIdx, BLOCK_SOLID);
            }
        }
        const baseIx = nBx << 2, baseIy = nBy << 2, baseIz = nBz << 2;
        let bits = freeLo;
        while (bits) {
            const bp = 31 - Math.clz32(bits & -bits);
            enqueueVoxel(baseIx + (bp & 3), baseIy + ((bp >> 2) & 3), baseIz + (bp >> 4));
            bits &= bits - 1;
        }
        bits = freeHi;
        while (bits) {
            const bp = 31 - Math.clz32(bits & -bits);
            const bi = bp + 32;
            enqueueVoxel(baseIx + (bi & 3), baseIy + ((bi >> 2) & 3), baseIz + (bi >> 4));
            bits &= bits - 1;
        }
    };
    const processBlock = (blockIdx) => {
        const bx = blockIdx % nbx;
        const byBz = (blockIdx / nbx) | 0;
        const by = byBz % nby;
        const bz = (byBz / nby) | 0;
        if (bx > 0) {
            const ni = blockIdx - 1;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 1, bx - 1, by, bz);
            }
        }
        if (bx < nbx - 1) {
            const ni = blockIdx + 1;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 0, bx + 1, by, bz);
            }
        }
        if (by > 0) {
            const ni = blockIdx - nbx;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 3, bx, by - 1, bz);
            }
        }
        if (by < nby - 1) {
            const ni = blockIdx + nbx;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 2, bx, by + 1, bz);
            }
        }
        if (bz > 0) {
            const ni = blockIdx - bStride;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 5, bx, by, bz - 1);
            }
        }
        if (bz < nbz - 1) {
            const ni = blockIdx + bStride;
            const nbt = readBlockType(blocked.types, ni);
            if (nbt === BLOCK_EMPTY) {
                tryFillBlock(ni);
            }
            else if (nbt === BLOCK_MIXED) {
                enqueueFaceVoxels(ni, 4, bx, by, bz + 1);
            }
        }
    };
    const tryEnqueueVoxel = (ix, iy, iz) => {
        const blockIdx = (ix >> 2) + (iy >> 2) * nbx + (iz >> 2) * bStride;
        const bbt = readBlockType(blocked.types, blockIdx);
        if (bbt === BLOCK_SOLID) {
            return;
        }
        if (bbt === BLOCK_EMPTY) {
            tryFillBlock(blockIdx);
            return;
        }
        const bs = bMasks.slot(blockIdx);
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        if (bitIdx < 32 ? (bMasks.lo[bs] >>> bitIdx) & 1 : (bMasks.hi[bs] >>> (bitIdx - 32)) & 1) {
            return;
        }
        const vbt = readBlockType(visited.types, blockIdx);
        if (vbt === BLOCK_SOLID) {
            return;
        }
        if (vbt === BLOCK_MIXED) {
            const vs = vMasks.slot(blockIdx);
            if (bitIdx < 32 ? (vMasks.lo[vs] >>> bitIdx) & 1 : (vMasks.hi[vs] >>> (bitIdx - 32)) & 1) {
                return;
            }
            if (bitIdx < 32) {
                vMasks.lo[vs] = (vMasks.lo[vs] | (1 << bitIdx)) >>> 0;
            }
            else {
                vMasks.hi[vs] = (vMasks.hi[vs] | (1 << (bitIdx - 32))) >>> 0;
            }
            if (vMasks.lo[vs] === SOLID_LO && vMasks.hi[vs] === SOLID_HI) {
                vMasks.removeAt(vs);
                writeBlockType(visited.types, blockIdx, BLOCK_SOLID);
            }
        }
        else {
            writeBlockType(visited.types, blockIdx, BLOCK_MIXED);
            vMasks.set(blockIdx, bitIdx < 32 ? (1 << bitIdx) >>> 0 : 0, bitIdx >= 32 ? (1 << (bitIdx - 32)) >>> 0 : 0);
        }
        enqueueVoxel(ix, iy, iz);
    };
    for (let i = 0; i < blockSeeds.length; i++) {
        tryFillBlock(blockSeeds[i]);
    }
    for (let i = 0; i < voxelSeeds.length; i++) {
        const s = voxelSeeds[i];
        tryEnqueueVoxel(s.ix, s.iy, s.iz);
    }
    while (bqSize > 0 || vqSize > 0) {
        while (bqSize > 0) {
            const blockIdx = bqBuf[bqHead];
            bqHead = (bqHead + 1) & bqMask;
            bqSize--;
            processBlock(blockIdx);
        }
        if (vqSize > 0) {
            const ix = vqIx[vqHead], iy = vqIy[vqHead], iz = vqIz[vqHead];
            vqHead = (vqHead + 1) & vqMask;
            vqSize--;
            if (ix > 0) {
                tryEnqueueVoxel(ix - 1, iy, iz);
            }
            if (ix < nx - 1) {
                tryEnqueueVoxel(ix + 1, iy, iz);
            }
            if (iy > 0) {
                tryEnqueueVoxel(ix, iy - 1, iz);
            }
            if (iy < ny - 1) {
                tryEnqueueVoxel(ix, iy + 1, iz);
            }
            if (iz > 0) {
                tryEnqueueVoxel(ix, iy, iz - 1);
            }
            if (iz < nz - 1) {
                tryEnqueueVoxel(ix, iy, iz + 1);
            }
        }
    }
    return visited;
}
function cloneBounds(b) {
    return { min: { ...b.min }, max: { ...b.max } };
}
/**
 * Fill exterior-reachable space from boundary seeds and merge it back into
 * occupancy after dilation. Returns cropped bounds around navigable volume.
 */
export async function fillExterior(gridOriginal, gridBounds, voxelResolution, dilation, seed, backend = 'cpu') {
    if (!Number.isFinite(voxelResolution) || voxelResolution <= 0) {
        throw new Error(`fillExterior: voxelResolution must be finite and > 0, got ${voxelResolution}`);
    }
    if (!Number.isFinite(dilation) || dilation <= 0) {
        throw new Error(`fillExterior: dilation must be finite and > 0, got ${dilation}`);
    }
    const nx = Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution);
    const ny = Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution);
    const nz = Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution);
    if (nx % 4 !== 0 || ny % 4 !== 0 || nz % 4 !== 0) {
        throw new Error(`fillExterior: grid dimensions must be multiples of 4, got ${nx}x${ny}x${nz}`);
    }
    const halfExtent = Math.ceil(dilation / voxelResolution);
    const nbx = nx >> 2, nby = ny >> 2, nbz = nz >> 2;
    const dilated = await dilate3(gridOriginal, halfExtent, halfExtent, backend);
    const bStride = nbx * nby;
    const blockSeeds = [];
    const faceVoxelSeeds = [];
    const seedBoundaryBlock = (blockIdx, bx, by, bz, face) => {
        const bt = readBlockType(dilated.types, blockIdx);
        if (bt === BLOCK_SOLID) {
            return;
        }
        if (bt === BLOCK_EMPTY) {
            blockSeeds.push(blockIdx);
            return;
        }
        const ms = dilated.masks.slot(blockIdx);
        let freeLo = (FACE_MASKS_LO[face] & ~dilated.masks.lo[ms]) >>> 0;
        let freeHi = (FACE_MASKS_HI[face] & ~dilated.masks.hi[ms]) >>> 0;
        if (freeLo === 0 && freeHi === 0) {
            return;
        }
        const baseIx = bx << 2, baseIy = by << 2, baseIz = bz << 2;
        while (freeLo) {
            const bp = 31 - Math.clz32(freeLo & -freeLo);
            faceVoxelSeeds.push({ ix: baseIx + (bp & 3), iy: baseIy + ((bp >> 2) & 3), iz: baseIz + (bp >> 4) });
            freeLo &= freeLo - 1;
        }
        while (freeHi) {
            const bp = 31 - Math.clz32(freeHi & -freeHi);
            const bi = bp + 32;
            faceVoxelSeeds.push({ ix: baseIx + (bi & 3), iy: baseIy + ((bi >> 2) & 3), iz: baseIz + (bi >> 4) });
            freeHi &= freeHi - 1;
        }
    };
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            seedBoundaryBlock(by * nbx + bz * bStride, 0, by, bz, 0);
        }
    }
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            seedBoundaryBlock((nbx - 1) + by * nbx + bz * bStride, nbx - 1, by, bz, 1);
        }
    }
    for (let bz = 0; bz < nbz; bz++) {
        for (let bx = 0; bx < nbx; bx++) {
            seedBoundaryBlock(bx + bz * bStride, bx, 0, bz, 2);
        }
    }
    for (let bz = 0; bz < nbz; bz++) {
        for (let bx = 0; bx < nbx; bx++) {
            seedBoundaryBlock(bx + (nby - 1) * nbx + bz * bStride, bx, nby - 1, bz, 3);
        }
    }
    for (let by = 0; by < nby; by++) {
        for (let bx = 0; bx < nbx; bx++) {
            seedBoundaryBlock(bx + by * nbx, bx, by, 0, 4);
        }
    }
    for (let by = 0; by < nby; by++) {
        for (let bx = 0; bx < nbx; bx++) {
            seedBoundaryBlock(bx + by * nbx + (nbz - 1) * bStride, bx, by, nbz - 1, 5);
        }
    }
    const visited = twoLevelBFS(dilated, blockSeeds, faceVoxelSeeds, nx, ny, nz);
    const seedIx = Math.floor((seed.x - gridBounds.min.x) / voxelResolution);
    const seedIy = Math.floor((seed.y - gridBounds.min.y) / voxelResolution);
    const seedIz = Math.floor((seed.z - gridBounds.min.z) / voxelResolution);
    if (seedIx >= 0 && seedIx < nx && seedIy >= 0 && seedIy < ny && seedIz >= 0 && seedIz < nz) {
        if (visited.getVoxel(seedIx, seedIy, seedIz)) {
            logger.info('fillExteriorMap: seed reachable from outside, skipping');
            return { grid: gridOriginal, gridBounds };
        }
    }
    else {
        logger.info('fillExteriorMap: seed outside grid bounds, skipping exterior fill');
        return { grid: gridOriginal, gridBounds };
    }
    const dilatedVisited = await dilate3(visited, halfExtent, halfExtent, backend);
    const combined = sparseOrGrids(gridOriginal, dilatedVisited);
    let minIx = nx, minIy = ny, minIz = nz;
    let maxIx = 0, maxIy = 0, maxIz = 0;
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            for (let bx = 0; bx < nbx; bx++) {
                const blockIdx = bx + by * nbx + bz * combined.bStride;
                const bt = readBlockType(combined.types, blockIdx);
                if (bt === BLOCK_SOLID) {
                    continue;
                }
                if (bt === BLOCK_MIXED) {
                    const cs = combined.masks.slot(blockIdx);
                    if (combined.masks.lo[cs] === SOLID_LO && combined.masks.hi[cs] === SOLID_HI) {
                        continue;
                    }
                }
                const baseX = bx << 2, baseY = by << 2, baseZ = bz << 2;
                if (baseX < minIx) {
                    minIx = baseX;
                }
                if (baseX + 3 > maxIx) {
                    maxIx = baseX + 3;
                }
                if (baseY < minIy) {
                    minIy = baseY;
                }
                if (baseY + 3 > maxIy) {
                    maxIy = baseY + 3;
                }
                if (baseZ < minIz) {
                    minIz = baseZ;
                }
                if (baseZ + 3 > maxIz) {
                    maxIz = baseZ + 3;
                }
            }
        }
    }
    if (minIx > maxIx) {
        logger.warn('fillExteriorMap: no navigable cells remain, returning empty result');
        return { grid: new SparseVoxelGrid(4, 4, 4), gridBounds: { min: { ...gridBounds.min }, max: { ...gridBounds.min } } };
    }
    const MARGIN = 1;
    const cropMinBx = Math.max(0, (minIx >> 2) - MARGIN);
    const cropMinBy = Math.max(0, (minIy >> 2) - MARGIN);
    const cropMinBz = Math.max(0, (minIz >> 2) - MARGIN);
    const cropMaxBx = Math.min(nbx, (maxIx >> 2) + 1 + MARGIN);
    const cropMaxBy = Math.min(nby, (maxIy >> 2) + 1 + MARGIN);
    const cropMaxBz = Math.min(nbz, (maxIz >> 2) + 1 + MARGIN);
    const blockSize = 4 * voxelResolution;
    const croppedMin = {
        x: gridBounds.min.x + cropMinBx * blockSize,
        y: gridBounds.min.y + cropMinBy * blockSize,
        z: gridBounds.min.z + cropMinBz * blockSize
    };
    const croppedBounds = {
        min: croppedMin,
        max: {
            x: croppedMin.x + (cropMaxBx - cropMinBx) * blockSize,
            y: croppedMin.y + (cropMaxBy - cropMinBy) * blockSize,
            z: croppedMin.z + (cropMaxBz - cropMinBz) * blockSize
        }
    };
    return { grid: combined.cropTo(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz), gridBounds: croppedBounds };
}
/**
 * Carve navigable space for a capsule by:
 * 1) dilating blocked voxels by capsule dimensions
 * 2) flood filling reachable empty space from the seed
 * 3) dilating and inverting to final occupancy representation.
 */
export async function carve(grid, gridBounds, voxelResolution, capsuleHeight, capsuleRadius, seed, backend = 'cpu') {
    if (!Number.isFinite(voxelResolution) || voxelResolution <= 0) {
        throw new Error(`carve: voxelResolution must be finite and > 0, got ${voxelResolution}`);
    }
    if (!Number.isFinite(capsuleHeight) || capsuleHeight <= 0) {
        throw new Error(`carve: capsuleHeight must be finite and > 0, got ${capsuleHeight}`);
    }
    if (!Number.isFinite(capsuleRadius) || capsuleRadius < 0) {
        throw new Error(`carve: capsuleRadius must be finite and >= 0, got ${capsuleRadius}`);
    }
    const nx = Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution);
    const ny = Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution);
    const nz = Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution);
    if (nx % 4 !== 0 || ny % 4 !== 0 || nz % 4 !== 0) {
        throw new Error(`carve: grid dimensions must be multiples of 4, got ${nx}x${ny}x${nz}`);
    }
    const kernelR = Math.ceil(capsuleRadius / voxelResolution);
    const yHalfExtent = Math.ceil(capsuleHeight / (2 * voxelResolution));
    const nbx = nx >> 2;
    const nby = ny >> 2;
    const nbz = nz >> 2;
    const blocked = await dilate3(grid, kernelR, yHalfExtent, backend);
    const seedIx = Math.floor((seed.x - gridBounds.min.x) / voxelResolution);
    const seedIy = Math.floor((seed.y - gridBounds.min.y) / voxelResolution);
    const seedIz = Math.floor((seed.z - gridBounds.min.z) / voxelResolution);
    if (seedIx < 0 || seedIx >= nx || seedIy < 0 || seedIy >= ny || seedIz < 0 || seedIz >= nz) {
        logger.warn(`carve: seed (${seed.x}, ${seed.y}, ${seed.z}) outside grid, skipping`);
        return { grid, gridBounds: cloneBounds(gridBounds) };
    }
    let useSeedIx = seedIx, useSeedIy = seedIy, useSeedIz = seedIz;
    if (blocked.getVoxel(seedIx, seedIy, seedIz)) {
        const maxRadius = Math.max(kernelR, yHalfExtent) * 2;
        const found = SparseVoxelGrid.findNearestFreeCell(blocked, seedIx, seedIy, seedIz, maxRadius);
        if (!found) {
            logger.warn(`carve: seed (${seed.x}, ${seed.y}, ${seed.z}) blocked after dilation, no free cell within ${maxRadius} voxels, skipping`);
            return { grid, gridBounds: cloneBounds(gridBounds) };
        }
        useSeedIx = found.ix;
        useSeedIy = found.iy;
        useSeedIz = found.iz;
    }
    const seedBlockIdx = (useSeedIx >> 2) + (useSeedIy >> 2) * nbx + (useSeedIz >> 2) * (nbx * nby);
    const seedBt = readBlockType(blocked.types, seedBlockIdx);
    const blockSeeds = seedBt === BLOCK_EMPTY ? [seedBlockIdx] : [];
    const voxelSeeds = seedBt === BLOCK_EMPTY ? [] : [{ ix: useSeedIx, iy: useSeedIy, iz: useSeedIz }];
    const visited = twoLevelBFS(blocked, blockSeeds, voxelSeeds, nx, ny, nz);
    // useless?
    const emptyGrid = computeEmptyGrid(visited, blocked);
    const navRegion = await dilate3(emptyGrid, kernelR, yHalfExtent, backend);
    const navBounds = navRegion.getOccupiedBlockBounds();
    if (!navBounds) {
        logger.warn('carve: no navigable cells remain, returning empty result');
        return { grid: new SparseVoxelGrid(4, 4, 4), gridBounds: { min: { ...gridBounds.min }, max: { ...gridBounds.min } } };
    }
    const MARGIN = 1;
    const cropMinBx = Math.max(0, navBounds.minBx - MARGIN);
    const cropMinBy = Math.max(0, navBounds.minBy - MARGIN);
    const cropMinBz = Math.max(0, navBounds.minBz - MARGIN);
    const cropMaxBx = Math.min(nbx, navBounds.maxBx + 1 + MARGIN);
    const cropMaxBy = Math.min(nby, navBounds.maxBy + 1 + MARGIN);
    const cropMaxBz = Math.min(nbz, navBounds.maxBz + 1 + MARGIN);
    const blockSize = 4 * voxelResolution;
    const croppedMin = {
        x: gridBounds.min.x + cropMinBx * blockSize,
        y: gridBounds.min.y + cropMinBy * blockSize,
        z: gridBounds.min.z + cropMinBz * blockSize
    };
    const croppedBounds = {
        min: croppedMin,
        max: {
            x: croppedMin.x + (cropMaxBx - cropMinBx) * blockSize,
            y: croppedMin.y + (cropMaxBy - cropMinBy) * blockSize,
            z: croppedMin.z + (cropMaxBz - cropMinBz) * blockSize
        }
    };
    return { grid: navRegion.cropToInverted(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz), gridBounds: croppedBounds };
}
/**
 * Floor-fill via XZ dilate -> per-column upward walk -> XZ dilate -> OR.
 * This mirrors upstream's block/bitmask walk instead of per-voxel getVoxel checks.
 */
export async function fillFloor(gridOriginal, gridBounds, voxelResolution, dilation = 0, backend = 'cpu') {
    const nx = Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution);
    const ny = Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution);
    const nz = Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution);
    if (nx % 4 !== 0 || ny % 4 !== 0 || nz % 4 !== 0) {
        return { grid: gridOriginal, gridBounds };
    }
    const halfExtent = Math.max(0, Math.ceil(dilation / voxelResolution));
    const dilatedSolid = halfExtent > 0 ? await dilate3(gridOriginal, halfExtent, 0, backend) : gridOriginal;
    const { nbx, nby, nbz, bStride } = gridOriginal;
    const foundEmpty = new SparseVoxelGrid(nx, ny, nz);
    const dilatedTypes = dilatedSolid.types;
    for (let bz = 0; bz < nbz; bz++) {
        for (let bx = 0; bx < nbx; bx++) {
            let walking = 0xFFFF;
            for (let by = 0; by < nby && walking; by++) {
                const blockIdx = bx + by * nbx + bz * bStride;
                const bt = readBlockType(dilatedTypes, blockIdx);
                if (bt === BLOCK_SOLID) {
                    break;
                }
                if (bt === BLOCK_EMPTY) {
                    if (walking === 0xFFFF) {
                        foundEmpty.orBlock(blockIdx, SOLID_LO, SOLID_HI);
                    }
                    else {
                        let lo = 0;
                        let hi = 0;
                        for (let lz = 0; lz < 4; lz++) {
                            for (let lx = 0; lx < 4; lx++) {
                                if (!(walking & (1 << (lz * 4 + lx)))) {
                                    continue;
                                }
                                for (let ly = 0; ly < 4; ly++) {
                                    const bitIdx = lx + (ly << 2) + (lz << 4);
                                    if (bitIdx < 32) {
                                        lo |= 1 << bitIdx;
                                    }
                                    else {
                                        hi |= 1 << (bitIdx - 32);
                                    }
                                }
                            }
                        }
                        foundEmpty.orBlock(blockIdx, lo >>> 0, hi >>> 0);
                    }
                    continue;
                }
                const s = dilatedSolid.masks.slot(blockIdx);
                const dLo = dilatedSolid.masks.lo[s];
                const dHi = dilatedSolid.masks.hi[s];
                let foundLo = 0;
                let foundHi = 0;
                for (let lz = 0; lz < 4; lz++) {
                    for (let lx = 0; lx < 4; lx++) {
                        const subCol = 1 << (lz * 4 + lx);
                        if (!(walking & subCol)) {
                            continue;
                        }
                        for (let ly = 0; ly < 4; ly++) {
                            const bitIdx = lx + (ly << 2) + (lz << 4);
                            const inHi = bitIdx >= 32;
                            const word = inHi ? dHi : dLo;
                            const bit = 1 << (inHi ? bitIdx - 32 : bitIdx);
                            if (word & bit) {
                                walking &= ~subCol;
                                break;
                            }
                            if (inHi) {
                                foundHi |= bit;
                            }
                            else {
                                foundLo |= bit;
                            }
                        }
                    }
                }
                if (foundLo || foundHi) {
                    foundEmpty.orBlock(blockIdx, foundLo >>> 0, foundHi >>> 0);
                }
            }
        }
    }
    if (halfExtent > 0) {
        dilatedSolid.clear();
    }
    const foundDilated = halfExtent > 0 ? await dilate3(foundEmpty, halfExtent, 0, backend) : foundEmpty;
    const combined = sparseOrGrids(gridOriginal, foundDilated, true);
    return { grid: combined, gridBounds: cloneBounds(gridBounds) };
}
