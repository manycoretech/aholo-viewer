import { popcount, BlockMaskBuffer, type SparseVoxelGrid, type Bounds, SOLID_HI, SOLID_LO } from './common.js';
import { logger } from '../Logger.js';

const FACE_X0 = 0x11111111;
const FACE_X3 = 0x88888888;
const FACE_Y0 = 0x000f000f;
const FACE_Y3 = 0xf000f000;
const FACE_Z0_LO = 0x0000ffff;
const FACE_Z3_HI = 0xffff0000 >>> 0;

function sortedUint32Has(sorted: Float64Array, value: number) {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = sorted[mid];
        if (v < value) {
            lo = mid + 1;
        } else if (v > value) {
            hi = mid - 1;
        } else {
            return true;
        }
    }
    return false;
}

function findMixedBlockIndex(sortedBlockIdx: Float64Array, target: number) {
    let lo = 0;
    let hi = sortedBlockIdx.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = sortedBlockIdx[mid];
        if (v < target) {
            lo = mid + 1;
        } else if (v > target) {
            hi = mid - 1;
        } else {
            return mid;
        }
    }
    return undefined;
}

function sortMixedByBlockIdx(blockIdx: Float64Array, masks: Uint32Array): void {
    const n = blockIdx.length;
    if (n <= 1) {
        return;
    }
    const stackLo: number[] = [0];
    const stackHi: number[] = [n - 1];
    function swap(a: number, b: number) {
        const k = blockIdx[a];
        blockIdx[a] = blockIdx[b];
        blockIdx[b] = k;
        const alo = masks[a * 2];
        const ahi = masks[a * 2 + 1];
        masks[a * 2] = masks[b * 2];
        masks[a * 2 + 1] = masks[b * 2 + 1];
        masks[b * 2] = alo;
        masks[b * 2 + 1] = ahi;
    }
    while (stackLo.length > 0) {
        const lo = stackLo.pop()!;
        const hi = stackHi.pop()!;
        if (hi - lo < 16) {
            for (let i = lo + 1; i <= hi; i++) {
                const k = blockIdx[i];
                const m0 = masks[i * 2];
                const m1 = masks[i * 2 + 1];
                let j = i - 1;
                while (j >= lo && blockIdx[j] > k) {
                    blockIdx[j + 1] = blockIdx[j];
                    masks[(j + 1) * 2] = masks[j * 2];
                    masks[(j + 1) * 2 + 1] = masks[j * 2 + 1];
                    j--;
                }
                blockIdx[j + 1] = k;
                masks[(j + 1) * 2] = m0;
                masks[(j + 1) * 2 + 1] = m1;
            }
            continue;
        }
        const mid = (lo + hi) >>> 1;
        if (blockIdx[mid] < blockIdx[lo]) {
            swap(mid, lo);
        }
        if (blockIdx[hi] < blockIdx[lo]) {
            swap(hi, lo);
        }
        if (blockIdx[hi] < blockIdx[mid]) {
            swap(hi, mid);
        }
        const pivot = blockIdx[mid];
        let i = lo;
        let j = hi;
        while (i <= j) {
            while (blockIdx[i] < pivot) {
                i++;
            }
            while (blockIdx[j] > pivot) {
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
        } else {
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
}

function addCrossFace(
    nx: number,
    ny: number,
    nz: number,
    nbx: number,
    nby: number,
    nbz: number,
    hasSolid: (blockIdx: number) => boolean,
    getMixedIndex: (blockIdx: number) => number | undefined,
    masks: Uint32Array,
    ourFaceMask: number,
    adjFaceMask: number,
    shiftAmount: number,
    shiftLeft: boolean,
    curLo: number,
    curHi: number,
    write: (lo: number, hi: number) => void,
) {
    if (nx < 0 || ny < 0 || nz < 0 || nx >= nbx || ny >= nby || nz >= nbz) {
        write(curLo, curHi);
        return;
    }
    const adjBlockIdx = nx + ny * nbx + nz * nbx * nby;
    if (hasSolid(adjBlockIdx)) {
        write(curLo | ourFaceMask, curHi | ourFaceMask);
        return;
    }
    const adjIdx = getMixedIndex(adjBlockIdx);
    if (adjIdx === undefined) {
        write(curLo, curHi);
        return;
    }
    const adjLo = masks[adjIdx * 2];
    const adjHi = masks[adjIdx * 2 + 1];
    const faceLo = adjLo & adjFaceMask;
    const faceHi = adjHi & adjFaceMask;
    if (shiftLeft) {
        write(curLo | (faceLo << shiftAmount), curHi | (faceHi << shiftAmount));
    } else {
        write(curLo | (faceLo >>> shiftAmount), curHi | (faceHi >>> shiftAmount));
    }
}

function addCrossFaceZ(
    nx: number,
    ny: number,
    nz: number,
    nbx: number,
    nby: number,
    nbz: number,
    hasSolid: (blockIdx: number) => boolean,
    getMixedIndex: (blockIdx: number) => number | undefined,
    masks: Uint32Array,
    plusZ: boolean,
    curLo: number,
    curHi: number,
    write: (lo: number, hi: number) => void,
) {
    if (nx < 0 || ny < 0 || nz < 0 || nx >= nbx || ny >= nby || nz >= nbz) {
        write(curLo, curHi);
        return;
    }
    const adjBlockIdx = nx + ny * nbx + nz * nbx * nby;
    if (hasSolid(adjBlockIdx)) {
        if (plusZ) {
            write(curLo, curHi | FACE_Z3_HI);
        } else {
            write(curLo | FACE_Z0_LO, curHi);
        }
        return;
    }
    const adjIdx = getMixedIndex(adjBlockIdx);
    if (adjIdx === undefined) {
        write(curLo, curHi);
        return;
    }
    const adjLo = masks[adjIdx * 2];
    const adjHi = masks[adjIdx * 2 + 1];
    if (plusZ) {
        write(curLo, curHi | ((adjLo & FACE_Z0_LO) << 16));
    } else {
        write(curLo | ((adjHi & FACE_Z3_HI) >>> 16), curHi);
    }
}

/**
 * Block cleanup pass:
 * - remove voxels that have no supporting 6-neighborhood occupancy
 * - fill single-voxel holes fully enclosed by 6 neighbors
 * Includes cross-block neighbor propagation for face-adjacent blocks.
 */
export function filterAndFillBlocks(
    blocks: BlockMaskBuffer,
    nbx = Infinity,
    nby = Infinity,
    nbz = Infinity,
): BlockMaskBuffer {
    const mixed = blocks.getMixedBlocks();
    const solids = blocks.getSolidBlocks();
    const mixedCount = mixed.blockIdx.length;
    const masks = mixed.masks;
    if (mixedCount === 0) {
        return blocks;
    }

    const mixedBlockIdx = new Float64Array(mixedCount);
    for (let i = 0; i < mixedCount; i++) {
        mixedBlockIdx[i] = mixed.blockIdx[i];
    }
    sortMixedByBlockIdx(mixedBlockIdx, masks);
    const sortedSolid = new Float64Array(solids.length);
    for (let i = 0; i < solids.length; i++) {
        sortedSolid[i] = solids[i];
    }
    sortedSolid.sort();
    function hasSolid(blockIdx: number): boolean {
        return sortedUint32Has(sortedSolid, blockIdx);
    }
    function getMixedIndex(blockIdx: number): number | undefined {
        return findMixedBlockIndex(mixedBlockIdx, blockIdx);
    }

    const newMasks = new Uint32Array(masks.length);
    let voxelsRemoved = 0;
    let voxelsFilled = 0;
    for (let i = 0; i < mixedCount; i++) {
        const blockIdx = mixedBlockIdx[i];
        const origLo = masks[i * 2];
        const origHi = masks[i * 2 + 1];
        const bx = blockIdx % nbx;
        const byBz = (blockIdx / nbx) | 0;
        const by = byBz % nby;
        const bz = (blockIdx / (nbx * nby)) | 0;

        let pxLo = (origLo >>> 1) & ~FACE_X3;
        let pxHi = (origHi >>> 1) & ~FACE_X3;
        let mxLo = (origLo << 1) & ~FACE_X0;
        let mxHi = (origHi << 1) & ~FACE_X0;
        let pyLo = (origLo >>> 4) & ~FACE_Y3;
        let pyHi = (origHi >>> 4) & ~FACE_Y3;
        let myLo = (origLo << 4) & ~FACE_Y0;
        let myHi = (origHi << 4) & ~FACE_Y0;
        let pzLo = (origLo >>> 16) | (origHi << 16);
        let pzHi = origHi >>> 16;
        let mzLo = origLo << 16;
        let mzHi = (origHi << 16) | (origLo >>> 16);

        function writePx(lo: number, hi: number): void {
            pxLo = lo;
            pxHi = hi;
        }
        function writeMx(lo: number, hi: number): void {
            mxLo = lo;
            mxHi = hi;
        }
        function writePy(lo: number, hi: number): void {
            pyLo = lo;
            pyHi = hi;
        }
        function writeMy(lo: number, hi: number): void {
            myLo = lo;
            myHi = hi;
        }
        function writePz(lo: number, hi: number): void {
            pzLo = lo;
            pzHi = hi;
        }
        function writeMz(lo: number, hi: number): void {
            mzLo = lo;
            mzHi = hi;
        }

        addCrossFace(
            bx + 1,
            by,
            bz,
            nbx,
            nby,
            nbz,
            hasSolid,
            getMixedIndex,
            masks,
            FACE_X3,
            FACE_X0,
            3,
            true,
            pxLo,
            pxHi,
            writePx,
        );
        addCrossFace(
            bx - 1,
            by,
            bz,
            nbx,
            nby,
            nbz,
            hasSolid,
            getMixedIndex,
            masks,
            FACE_X0,
            FACE_X3,
            3,
            false,
            mxLo,
            mxHi,
            writeMx,
        );
        addCrossFace(
            bx,
            by + 1,
            bz,
            nbx,
            nby,
            nbz,
            hasSolid,
            getMixedIndex,
            masks,
            FACE_Y3,
            FACE_Y0,
            12,
            true,
            pyLo,
            pyHi,
            writePy,
        );
        addCrossFace(
            bx,
            by - 1,
            bz,
            nbx,
            nby,
            nbz,
            hasSolid,
            getMixedIndex,
            masks,
            FACE_Y0,
            FACE_Y3,
            12,
            false,
            myLo,
            myHi,
            writeMy,
        );
        addCrossFaceZ(bx, by, bz + 1, nbx, nby, nbz, hasSolid, getMixedIndex, masks, true, pzLo, pzHi, writePz);
        addCrossFaceZ(bx, by, bz - 1, nbx, nby, nbz, hasSolid, getMixedIndex, masks, false, mzLo, mzHi, writeMz);

        const neighborLo = pxLo | mxLo | pyLo | myLo | pzLo | mzLo;
        const neighborHi = pxHi | mxHi | pyHi | myHi | pzHi | mzHi;
        let lo = origLo & neighborLo;
        let hi = origHi & neighborHi;
        const fillLo = ~lo & pxLo & mxLo & pyLo & myLo & pzLo & mzLo;
        const fillHi = ~hi & pxHi & mxHi & pyHi & myHi & pzHi & mzHi;
        lo |= fillLo;
        hi |= fillHi;
        voxelsRemoved += popcount(origLo & ~lo) + popcount(origHi & ~hi);
        voxelsFilled += popcount(lo & ~origLo) + popcount(hi & ~origHi);
        newMasks[i * 2] = lo >>> 0;
        newMasks[i * 2 + 1] = hi >>> 0;
    }

    const result = new BlockMaskBuffer();
    for (let i = 0; i < mixedCount; i++) {
        const lo = newMasks[i * 2];
        const hi = newMasks[i * 2 + 1];
        result.addBlock(mixedBlockIdx[i], lo, hi);
    }
    for (let i = 0; i < solids.length; i++) {
        result.addBlock(solids[i], SOLID_LO, SOLID_HI);
    }
    logger.info(`voxel filter: ${voxelsRemoved} voxels removed, ${voxelsFilled} voxels filled`);
    return result;
}

export type { Bounds } from './common.js';

/** Crop blocks into [min, max) block range and rebase linear block coordinates. */
export function cropBlocksToRange(
    blocks: BlockMaskBuffer,
    sourceNbx: number,
    sourceNby: number,
    cropMinBx: number,
    cropMinBy: number,
    cropMinBz: number,
    cropMaxBx: number,
    cropMaxBy: number,
    cropMaxBz: number,
): BlockMaskBuffer {
    const cropped = new BlockMaskBuffer();
    const outNbx = cropMaxBx - cropMinBx;
    const outNby = cropMaxBy - cropMinBy;
    const sourceBStride = sourceNbx * sourceNby;
    const solids = blocks.getSolidBlocks();
    for (let i = 0; i < solids.length; i++) {
        const blockIdx = solids[i];
        const bx = blockIdx % sourceNbx;
        const byBz = (blockIdx / sourceNbx) | 0;
        const by = byBz % sourceNby;
        const bz = (blockIdx / sourceBStride) | 0;
        if (bx < cropMinBx || by < cropMinBy || bz < cropMinBz) {
            continue;
        }
        if (bx >= cropMaxBx || by >= cropMaxBy || bz >= cropMaxBz) {
            continue;
        }
        cropped.addBlock(
            bx - cropMinBx + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outNbx * outNby,
            SOLID_LO,
            SOLID_HI,
        );
    }
    const mixed = blocks.getMixedBlocks();
    for (let i = 0; i < mixed.blockIdx.length; i++) {
        const blockIdx = mixed.blockIdx[i];
        const bx = blockIdx % sourceNbx;
        const byBz = (blockIdx / sourceNbx) | 0;
        const by = byBz % sourceNby;
        const bz = (blockIdx / sourceBStride) | 0;
        if (bx < cropMinBx || by < cropMinBy || bz < cropMinBz) {
            continue;
        }
        if (bx >= cropMaxBx || by >= cropMaxBy || bz >= cropMaxBz) {
            continue;
        }
        cropped.addBlock(
            bx - cropMinBx + (by - cropMinBy) * outNbx + (bz - cropMinBz) * outNbx * outNby,
            mixed.masks[i * 2],
            mixed.masks[i * 2 + 1],
        );
    }
    return cropped;
}

/** Compute world-space bounds corresponding to a cropped block range. */
export function cropBounds(
    gridBounds: Bounds,
    voxelResolution: number,
    cropMinBx: number,
    cropMinBy: number,
    cropMinBz: number,
    cropMaxBx: number,
    cropMaxBy: number,
    cropMaxBz: number,
): Bounds {
    const blockSize = 4 * voxelResolution;
    const croppedMin = {
        x: gridBounds.min.x + cropMinBx * blockSize,
        y: gridBounds.min.y + cropMinBy * blockSize,
        z: gridBounds.min.z + cropMinBz * blockSize,
    };
    return {
        min: croppedMin,
        max: {
            x: croppedMin.x + (cropMaxBx - cropMinBx) * blockSize,
            y: croppedMin.y + (cropMaxBy - cropMinBy) * blockSize,
            z: croppedMin.z + (cropMaxBz - cropMinBz) * blockSize,
        },
    };
}

/** Tight crop to occupied block bounds. */
export function cropToOccupied(
    grid: SparseVoxelGrid,
    gridBounds: Bounds,
    voxelResolution: number,
): { grid: SparseVoxelGrid; gridBounds: Bounds } {
    const occupied = grid.getOccupiedBlockBounds();
    if (!occupied) {
        return { grid, gridBounds };
    }
    const { minBx, minBy, minBz, maxBx, maxBy, maxBz } = occupied;
    const cropMaxBx = maxBx + 1;
    const cropMaxBy = maxBy + 1;
    const cropMaxBz = maxBz + 1;
    const { nbx, nby, nbz } = grid;
    if (minBx === 0 && minBy === 0 && minBz === 0 && cropMaxBx === nbx && cropMaxBy === nby && cropMaxBz === nbz) {
        return { grid, gridBounds };
    }
    return {
        grid: grid.cropTo(minBx, minBy, minBz, cropMaxBx, cropMaxBy, cropMaxBz),
        gridBounds: cropBounds(gridBounds, voxelResolution, minBx, minBy, minBz, cropMaxBx, cropMaxBy, cropMaxBz),
    };
}

/** Tight crop to navigable (non-fully-solid) block bounds. */
export function cropToNavigable(
    grid: SparseVoxelGrid,
    gridBounds: Bounds,
    voxelResolution: number,
): { grid: SparseVoxelGrid; gridBounds: Bounds } {
    const navBounds = grid.getNavigableBlockBounds();
    if (!navBounds) {
        return { grid, gridBounds };
    }
    const { minBx, minBy, minBz, maxBx, maxBy, maxBz } = navBounds;
    const { nbx, nby, nbz } = grid;

    // Keep one solid wall block around the navigable cavity. The runtime
    // treats out-of-grid as solid, but collision extraction sees out-of-grid
    // as empty; this padding keeps collision meshes sealed at crop edges.
    const MARGIN = 1;
    const cropMinBx = Math.max(0, minBx - MARGIN);
    const cropMinBy = Math.max(0, minBy - MARGIN);
    const cropMinBz = Math.max(0, minBz - MARGIN);
    const cropMaxBx = Math.min(nbx, maxBx + 1 + MARGIN);
    const cropMaxBy = Math.min(nby, maxBy + 1 + MARGIN);
    const cropMaxBz = Math.min(nbz, maxBz + 1 + MARGIN);

    if (
        cropMinBx === 0 &&
        cropMinBy === 0 &&
        cropMinBz === 0 &&
        cropMaxBx === nbx &&
        cropMaxBy === nby &&
        cropMaxBz === nbz
    ) {
        return { grid, gridBounds };
    }
    return {
        grid: grid.cropTo(cropMinBx, cropMinBy, cropMinBz, cropMaxBx, cropMaxBy, cropMaxBz),
        gridBounds: cropBounds(
            gridBounds,
            voxelResolution,
            cropMinBx,
            cropMinBy,
            cropMinBz,
            cropMaxBx,
            cropMaxBy,
            cropMaxBz,
        ),
    };
}
