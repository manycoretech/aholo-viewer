import { ColIdx, SplatData } from '../../SplatData.js';
import { logger } from '../Logger.js';
import {
    alignGridBounds,
    popcount,
    BLOCK_EMPTY,
    BLOCK_MIXED,
    BLOCK_SOLID,
    BlockMaskBuffer,
    extentsFromQuatScale,
    readBlockType,
    SOLID_HI,
    SOLID_LO,
    SparseVoxelGrid,
    writeBlockType,
    type Bounds,
} from './common.js';
import { cpuVoxelize, gpuVoxelize } from './voxelize.js';

export interface FilterClusterOptions {
    voxelResolution?: number;
    opacityCutoff?: number;
    minContribution?: number;
    seed?: { x: number; y: number; z: number };
}

export interface FilterClusterRuntimeOptions {
    backend?: 'cpu' | 'gpu';
    cpuWorkerCount?: number;
    box?: { minCorner: [number, number, number]; maxCorner: [number, number, number] };
}

interface BlockLookup {
    solidSet: Set<number>;
    mixedMap: Map<number, number>;
    masks: Uint32Array<ArrayBufferLike>;
}

interface BlockGridParams {
    gridMinX: number;
    gridMinY: number;
    gridMinZ: number;
    blockSize: number;
    voxelResolution: number;
    numBlocksX: number;
    numBlocksY: number;
    numBlocksZ: number;
    strideY: number;
    strideZ: number;
}

interface VoxelCluster {
    grid: SparseVoxelGrid;
    voxelCount: number;
}

interface GaussianSelectionResult {
    selectedIndices: number[];
    aborted: boolean;
}

const QUEUE_CAP_MAX = 1 << 30;
const FALLBACK_MIN_GAUSSIAN_RATIO = 0.3;
const FALLBACK_CANDIDATE_LIMIT = 5;

function countOccupiedVoxels(buffer: BlockMaskBuffer): number {
    let count = buffer.getSolidBlocks().length * 64;
    const mixed = buffer.getMixedBlocks();
    for (let i = 0; i < mixed.blockIdx.length; i++) {
        count += popcount(mixed.masks[i * 2]) + popcount(mixed.masks[i * 2 + 1]);
    }
    return count;
}

function makeFaceMask(axis: 0 | 1 | 2, value: number): [number, number] {
    let lo = 0;
    let hi = 0;
    for (let z = 0; z < 4; z++) {
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                if ((axis === 0 && x !== value) || (axis === 1 && y !== value) || (axis === 2 && z !== value)) {
                    continue;
                }
                const bit = x + y * 4 + z * 16;
                if (bit < 32) {
                    lo = (lo | (1 << bit)) >>> 0;
                } else {
                    hi = (hi | (1 << (bit - 32))) >>> 0;
                }
            }
        }
    }
    return [lo >>> 0, hi >>> 0];
}

const FACE_MASKS: Array<[number, number]> = [
    makeFaceMask(0, 0),
    makeFaceMask(0, 3),
    makeFaceMask(1, 0),
    makeFaceMask(1, 3),
    makeFaceMask(2, 0),
    makeFaceMask(2, 3),
];

function voxelMask(ix: number, iy: number, iz: number): [number, number] {
    const bit = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
    return bit < 32 ? [(1 << bit) >>> 0, 0] : [0, (1 << (bit - 32)) >>> 0];
}

function buildBlockLookup(buffer: BlockMaskBuffer): BlockLookup {
    const solidSet = new Set<number>();
    const solid = buffer.getSolidBlocks();
    for (let i = 0; i < solid.length; i++) {
        solidSet.add(solid[i]);
    }
    const mixed = buffer.getMixedBlocks();
    const mixedMap = new Map<number, number>();
    for (let i = 0; i < mixed.blockIdx.length; i++) {
        mixedMap.set(mixed.blockIdx[i], i);
    }
    return { solidSet, mixedMap, masks: mixed.masks };
}

function isCenterInOccupiedVoxel(
    px: number,
    py: number,
    pz: number,
    grid: BlockGridParams,
    lookup: BlockLookup,
): boolean {
    const bx = Math.floor((px - grid.gridMinX) / grid.blockSize);
    const by = Math.floor((py - grid.gridMinY) / grid.blockSize);
    const bz = Math.floor((pz - grid.gridMinZ) / grid.blockSize);
    if (bx < 0 || bx >= grid.numBlocksX || by < 0 || by >= grid.numBlocksY || bz < 0 || bz >= grid.numBlocksZ) {
        return false;
    }
    const blockIdx = bx + by * grid.strideY + bz * grid.strideZ;
    if (lookup.solidSet.has(blockIdx)) {
        return true;
    }
    const mixedIdx = lookup.mixedMap.get(blockIdx);
    if (mixedIdx === undefined) {
        return false;
    }
    const lx = Math.floor((px - grid.gridMinX - bx * grid.blockSize) / grid.voxelResolution) & 3;
    const ly = Math.floor((py - grid.gridMinY - by * grid.blockSize) / grid.voxelResolution) & 3;
    const lz = Math.floor((pz - grid.gridMinZ - bz * grid.blockSize) / grid.voxelResolution) & 3;
    const bitIdx = lx + ly * 4 + lz * 16;
    const word = bitIdx < 32 ? lookup.masks[mixedIdx * 2] : lookup.masks[mixedIdx * 2 + 1];
    return ((word >>> (bitIdx & 31)) & 1) !== 0;
}

function gaussianAtVoxelCenter(
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number,
    opacity: number,
    vx: number,
    vy: number,
    vz: number,
): number {
    const dx = vx - px;
    const dy = vy - py;
    const dz = vz - pz;
    const iqx = -qx;
    const iqy = -qy;
    const iqz = -qz;
    const tx = 2 * (iqy * dz - iqz * dy);
    const ty = 2 * (iqz * dx - iqx * dz);
    const tz = 2 * (iqx * dy - iqy * dx);
    const lx = dx + qw * tx + (iqy * tz - iqz * ty);
    const ly = dy + qw * ty + (iqz * tx - iqx * tz);
    const lz = dz + qw * tz + (iqx * ty - iqy * tx);
    const isx = sx > 1e-8 ? 1 / sx : 1e8;
    const isy = sy > 1e-8 ? 1 / sy : 1e8;
    const isz = sz > 1e-8 ? 1 / sz : 1e8;
    const d2 = (lx * isx) ** 2 + (ly * isy) ** 2 + (lz * isz) ** 2;
    return opacity * Math.exp(-0.5 * d2);
}

function gaussianContributesToVoxels(
    i: number,
    data: SplatData,
    extents: Float32Array,
    grid: BlockGridParams,
    lookup: BlockLookup,
    minContribution: number,
    minHits = 1,
): boolean {
    const table = data.table;
    const px = table[ColIdx.x][i];
    const py = table[ColIdx.y][i];
    const pz = table[ColIdx.z][i];
    const ex = extents[i * 3];
    const ey = extents[i * 3 + 1];
    const ez = extents[i * 3 + 2];
    const minBx = Math.max(0, Math.floor((px - ex - grid.gridMinX) / grid.blockSize));
    const maxBx = Math.min(grid.numBlocksX - 1, Math.floor((px + ex - grid.gridMinX) / grid.blockSize));
    const minBy = Math.max(0, Math.floor((py - ey - grid.gridMinY) / grid.blockSize));
    const maxBy = Math.min(grid.numBlocksY - 1, Math.floor((py + ey - grid.gridMinY) / grid.blockSize));
    const minBz = Math.max(0, Math.floor((pz - ez - grid.gridMinZ) / grid.blockSize));
    const maxBz = Math.min(grid.numBlocksZ - 1, Math.floor((pz + ez - grid.gridMinZ) / grid.blockSize));
    const qx = table[ColIdx.qx][i];
    const qy = table[ColIdx.qy][i];
    const qz = table[ColIdx.qz][i];
    const qw = table[ColIdx.qw][i];
    const sx = table[ColIdx.sx][i];
    const sy = table[ColIdx.sy][i];
    const sz = table[ColIdx.sz][i];
    const opacity = table[ColIdx.a][i];
    let hits = 0;
    for (let bz = minBz; bz <= maxBz; bz++) {
        for (let by = minBy; by <= maxBy; by++) {
            for (let bx = minBx; bx <= maxBx; bx++) {
                const blockIdx = bx + by * grid.strideY + bz * grid.strideZ;
                const solid = lookup.solidSet.has(blockIdx);
                const mixedIdx = solid ? undefined : lookup.mixedMap.get(blockIdx);
                if (!solid && mixedIdx === undefined) {
                    continue;
                }
                const lo = solid ? 0xffff_ffff : lookup.masks[mixedIdx! * 2];
                const hi = solid ? 0xffff_ffff : lookup.masks[mixedIdx! * 2 + 1];
                const blockMinX = grid.gridMinX + bx * grid.blockSize;
                const blockMinY = grid.gridMinY + by * grid.blockSize;
                const blockMinZ = grid.gridMinZ + bz * grid.blockSize;
                for (let lz = 0; lz < 4; lz++) {
                    const word = lz < 2 ? lo : hi;
                    const zBitBase = (lz & 1) * 16;
                    const vz = blockMinZ + (lz + 0.5) * grid.voxelResolution;
                    for (let ly = 0; ly < 4; ly++) {
                        const bitBase = zBitBase + ly * 4;
                        const vy = blockMinY + (ly + 0.5) * grid.voxelResolution;
                        for (let lx = 0; lx < 4; lx++) {
                            if (((word >>> (bitBase + lx)) & 1) === 0) {
                                continue;
                            }
                            const vx = blockMinX + (lx + 0.5) * grid.voxelResolution;
                            if (
                                gaussianAtVoxelCenter(px, py, pz, qx, qy, qz, qw, sx, sy, sz, opacity, vx, vy, vz) >=
                                minContribution
                            ) {
                                if (++hits >= minHits) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return false;
}

function twoLevelBFS(
    blocked: SparseVoxelGrid,
    blockSeeds: number[],
    voxelSeeds: Array<{ ix: number; iy: number; iz: number }>,
    nx: number,
    ny: number,
    nz: number,
    visitedAccumulator?: SparseVoxelGrid,
): VoxelCluster {
    const visited = new SparseVoxelGrid(nx, ny, nz);
    let voxelCount = 0;
    const nbx = nx >> 2;
    const nby = ny >> 2;
    const bStride = nbx * nby;
    const blockedTypes = blocked.types;
    const blockedMasks = blocked.masks;
    const visitedTypes = visited.types;
    const visitedMasks = visited.masks;

    let bqCap = 1 << 14;
    let bq = new Uint32Array(bqCap);
    let bqMask = bqCap - 1;
    let bqHead = 0;
    let bqTail = 0;
    let bqSize = 0;

    let vqCap = 1 << 14;
    let vqX = new Uint32Array(vqCap);
    let vqY = new Uint32Array(vqCap);
    let vqZ = new Uint32Array(vqCap);
    let vqMask = vqCap - 1;
    let vqHead = 0;
    let vqTail = 0;
    let vqSize = 0;

    function growBlockQueue() {
        if (bqCap >= QUEUE_CAP_MAX) {
            throw new Error(
                `filterCluster: block queue exceeded ${QUEUE_CAP_MAX}; try a coarser filterCluster.voxelResolution`,
            );
        }
        const grown = new Uint32Array(bqCap * 2);
        for (let i = 0; i < bqSize; i++) {
            grown[i] = bq[(bqHead + i) & bqMask];
        }
        bq = grown;
        bqCap = grown.length;
        bqMask = bqCap - 1;
        bqHead = 0;
        bqTail = bqSize;
    }

    function growVoxelQueue() {
        if (vqCap >= QUEUE_CAP_MAX) {
            throw new Error(
                `filterCluster: voxel queue exceeded ${QUEUE_CAP_MAX}; try a coarser filterCluster.voxelResolution`,
            );
        }
        const grownX = new Uint32Array(vqCap * 2);
        const grownY = new Uint32Array(vqCap * 2);
        const grownZ = new Uint32Array(vqCap * 2);
        for (let i = 0; i < vqSize; i++) {
            const src = (vqHead + i) & vqMask;
            grownX[i] = vqX[src];
            grownY[i] = vqY[src];
            grownZ[i] = vqZ[src];
        }
        vqX = grownX;
        vqY = grownY;
        vqZ = grownZ;
        vqCap = grownX.length;
        vqMask = vqCap - 1;
        vqHead = 0;
        vqTail = vqSize;
    }

    function enqueueBlock(blockIdx: number) {
        if (bqSize >= bqCap) {
            growBlockQueue();
        }
        bq[bqTail] = blockIdx;
        bqTail = (bqTail + 1) & bqMask;
        bqSize++;
    }

    function enqueueVoxel(ix: number, iy: number, iz: number) {
        if (vqSize >= vqCap) {
            growVoxelQueue();
        }
        vqX[vqTail] = ix;
        vqY[vqTail] = iy;
        vqZ[vqTail] = iz;
        vqTail = (vqTail + 1) & vqMask;
        vqSize++;
    }

    function tryFillBlock(blockIdx: number): boolean {
        if (readBlockType(blockedTypes, blockIdx) !== BLOCK_EMPTY) {
            return false;
        }
        if (readBlockType(visitedTypes, blockIdx) !== BLOCK_EMPTY) {
            return false;
        }
        writeBlockType(visitedTypes, blockIdx, BLOCK_SOLID);
        if (visitedAccumulator) {
            visitedAccumulator.orBlock(blockIdx, SOLID_LO, SOLID_HI);
        }
        voxelCount += 64;
        enqueueBlock(blockIdx);
        return true;
    }

    function enqueueVisitedMaskVoxels(blockIdx: number, bx: number, by: number, bz: number, lo: number, hi: number) {
        if ((lo | hi) === 0) {
            return;
        }
        const baseX = bx << 2;
        const baseY = by << 2;
        const baseZ = bz << 2;
        let bt = readBlockType(visitedTypes, blockIdx);
        let slot = -1;
        let oldLo = 0;
        let oldHi = 0;
        if (bt === BLOCK_SOLID) {
            return;
        }
        if (bt === BLOCK_MIXED) {
            slot = visitedMasks.slot(blockIdx);
            oldLo = visitedMasks.lo[slot];
            oldHi = visitedMasks.hi[slot];
        } else {
            writeBlockType(visitedTypes, blockIdx, BLOCK_MIXED);
            visitedMasks.set(blockIdx, 0, 0);
            slot = visitedMasks.slot(blockIdx);
            bt = BLOCK_MIXED;
        }
        const newLo = (lo & ~oldLo) >>> 0;
        const newHi = (hi & ~oldHi) >>> 0;
        if ((newLo | newHi) === 0) {
            return;
        }
        if (visitedAccumulator) {
            visitedAccumulator.orBlock(blockIdx, newLo, newHi);
        }
        voxelCount += popcount(newLo) + popcount(newHi);
        visitedMasks.lo[slot] = (oldLo | newLo) >>> 0;
        visitedMasks.hi[slot] = (oldHi | newHi) >>> 0;
        if (visitedMasks.lo[slot] === SOLID_LO && visitedMasks.hi[slot] === SOLID_HI) {
            visitedMasks.removeAt(slot);
            writeBlockType(visitedTypes, blockIdx, BLOCK_SOLID);
        }
        let bits = newLo;
        while (bits) {
            const bit = 31 - Math.clz32(bits & -bits);
            enqueueVoxel(baseX + (bit & 3), baseY + ((bit >> 2) & 3), baseZ + (bit >> 4));
            bits &= bits - 1;
        }
        bits = newHi;
        while (bits) {
            const bit = 31 - Math.clz32(bits & -bits);
            const bi = bit + 32;
            enqueueVoxel(baseX + (bi & 3), baseY + ((bi >> 2) & 3), baseZ + (bi >> 4));
            bits &= bits - 1;
        }
    }

    function enqueueFaceVoxels(blockIdx: number, face: number, bx: number, by: number, bz: number) {
        if (readBlockType(visitedTypes, blockIdx) === BLOCK_SOLID) {
            return;
        }
        const blockedSlot = blockedMasks.slot(blockIdx);
        const visitedSlot = readBlockType(visitedTypes, blockIdx) === BLOCK_MIXED ? visitedMasks.slot(blockIdx) : -1;
        const [faceLo, faceHi] = FACE_MASKS[face];
        const freeLo =
            (faceLo & ~blockedMasks.lo[blockedSlot] & ~(visitedSlot >= 0 ? visitedMasks.lo[visitedSlot] : 0)) >>> 0;
        const freeHi =
            (faceHi & ~blockedMasks.hi[blockedSlot] & ~(visitedSlot >= 0 ? visitedMasks.hi[visitedSlot] : 0)) >>> 0;
        enqueueVisitedMaskVoxels(blockIdx, bx, by, bz, freeLo, freeHi);
    }

    function processBlock(blockIdx: number) {
        const bx = blockIdx % nbx;
        const byBz = (blockIdx / nbx) | 0;
        const by = byBz % nby;
        const bz = (byBz / nby) | 0;
        if (bx > 0) {
            const n = blockIdx - 1;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 1, bx - 1, by, bz);
            }
        }
        if (bx < nbx - 1) {
            const n = blockIdx + 1;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 0, bx + 1, by, bz);
            }
        }
        if (by > 0) {
            const n = blockIdx - nbx;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 3, bx, by - 1, bz);
            }
        }
        if (by < nby - 1) {
            const n = blockIdx + nbx;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 2, bx, by + 1, bz);
            }
        }
        if (bz > 0) {
            const n = blockIdx - bStride;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 5, bx, by, bz - 1);
            }
        }
        if (bz < (nz >> 2) - 1) {
            const n = blockIdx + bStride;
            const bt = readBlockType(blockedTypes, n);
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(n);
            } else if (bt === BLOCK_MIXED) {
                enqueueFaceVoxels(n, 4, bx, by, bz + 1);
            }
        }
    }

    function processVoxel(ix: number, iy: number, iz: number) {
        function visit(x: number, y: number, z: number) {
            if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) {
                return;
            }
            const blockIdx = (x >> 2) + (y >> 2) * nbx + (z >> 2) * bStride;
            const bt = readBlockType(blockedTypes, blockIdx);
            if (bt === BLOCK_SOLID) {
                return;
            }
            if (bt === BLOCK_EMPTY) {
                tryFillBlock(blockIdx);
                return;
            }
            const blockedSlot = blockedMasks.slot(blockIdx);
            const bit = (x & 3) + ((y & 3) << 2) + ((z & 3) << 4);
            const blockedWord = bit < 32 ? blockedMasks.lo[blockedSlot] : blockedMasks.hi[blockedSlot];
            if (((blockedWord >>> (bit & 31)) & 1) !== 0) {
                return;
            }
            const lo = bit < 32 ? (1 << bit) >>> 0 : 0;
            const hi = bit >= 32 ? (1 << (bit - 32)) >>> 0 : 0;
            enqueueVisitedMaskVoxels(blockIdx, x >> 2, y >> 2, z >> 2, lo, hi);
        }
        visit(ix - 1, iy, iz);
        visit(ix + 1, iy, iz);
        visit(ix, iy - 1, iz);
        visit(ix, iy + 1, iz);
        visit(ix, iy, iz - 1);
        visit(ix, iy, iz + 1);
    }

    for (const blockIdx of blockSeeds) {
        tryFillBlock(blockIdx);
    }
    for (const seed of voxelSeeds) {
        const [lo, hi] = voxelMask(seed.ix, seed.iy, seed.iz);
        enqueueVisitedMaskVoxels(
            (seed.ix >> 2) + (seed.iy >> 2) * nbx + (seed.iz >> 2) * bStride,
            seed.ix >> 2,
            seed.iy >> 2,
            seed.iz >> 2,
            lo,
            hi,
        );
    }
    while (bqSize > 0 || vqSize > 0) {
        if (bqSize > 0) {
            const blockIdx = bq[bqHead];
            bqHead = (bqHead + 1) & bqMask;
            bqSize--;
            processBlock(blockIdx);
        } else {
            const ix = vqX[vqHead];
            const iy = vqY[vqHead];
            const iz = vqZ[vqHead];
            vqHead = (vqHead + 1) & vqMask;
            vqSize--;
            processVoxel(ix, iy, iz);
        }
    }
    return { grid: visited, voxelCount };
}

function floodClusterFromSeed(
    blocked: SparseVoxelGrid,
    nx: number,
    ny: number,
    nz: number,
    seedIx: number,
    seedIy: number,
    seedIz: number,
): VoxelCluster | null {
    if (blocked.getVoxel(seedIx, seedIy, seedIz)) {
        const nearest = SparseVoxelGrid.findNearestFreeCell(blocked, seedIx, seedIy, seedIz, Math.max(nx, ny, nz));
        if (!nearest) {
            return null;
        }
        seedIx = nearest.ix;
        seedIy = nearest.iy;
        seedIz = nearest.iz;
        logger.warn(`filterCluster seed is empty; using nearest occupied voxel (${seedIx}, ${seedIy}, ${seedIz})`);
    }
    const seedBlockIdx = (seedIx >> 2) + (seedIy >> 2) * blocked.nbx + (seedIz >> 2) * blocked.bStride;
    const seedBlockType = readBlockType(blocked.types, seedBlockIdx);
    return twoLevelBFS(
        blocked,
        seedBlockType === BLOCK_EMPTY ? [seedBlockIdx] : [],
        seedBlockType === BLOCK_EMPTY ? [] : [{ ix: seedIx, iy: seedIy, iz: seedIz }],
        nx,
        ny,
        nz,
    );
}

function getProcessedMask(processed: SparseVoxelGrid, blockIdx: number): [number, number] {
    const blockType = readBlockType(processed.types, blockIdx);
    if (blockType === BLOCK_EMPTY) {
        return [0, 0];
    }
    if (blockType === BLOCK_SOLID) {
        return [SOLID_LO, SOLID_HI];
    }
    const slot = processed.masks.slot(blockIdx);
    return [processed.masks.lo[slot], processed.masks.hi[slot]];
}

function insertCandidate(candidates: VoxelCluster[], candidate: VoxelCluster, limit: number) {
    candidates.push(candidate);
    candidates.sort((a, b) => b.voxelCount - a.voxelCount);
    if (candidates.length > limit) {
        const removed = candidates.pop();
        removed?.grid.releaseStorage();
    }
}

function findLargestVoxelClusterCandidates(
    buffer: BlockMaskBuffer,
    blocked: SparseVoxelGrid,
    nx: number,
    ny: number,
    nz: number,
    limit: number,
    initialProcessed?: SparseVoxelGrid,
    initialComponentCount = 0,
): { candidates: VoxelCluster[]; componentCount: number } {
    const candidates: VoxelCluster[] = [];
    const processed = initialProcessed ?? new SparseVoxelGrid(nx, ny, nz);
    const nbx = nx >> 2;
    const nby = ny >> 2;
    const bStride = nbx * nby;
    let componentCount = initialComponentCount;

    function floodFromMask(blockIdx: number, lo: number, hi: number) {
        while ((lo | hi) !== 0) {
            const bit = lo ? 31 - Math.clz32(lo & -lo) : 31 - Math.clz32(hi & -hi) + 32;
            const bx = blockIdx % nbx;
            const byBz = (blockIdx / nbx) | 0;
            const by = byBz % nby;
            const bz = (blockIdx / bStride) | 0;
            const seedIx = (bx << 2) + (bit & 3);
            const seedIy = (by << 2) + ((bit >> 2) & 3);
            const seedIz = (bz << 2) + (bit >> 4);
            const seedBlockType = readBlockType(blocked.types, blockIdx);
            const floodResult = twoLevelBFS(
                blocked,
                seedBlockType === BLOCK_EMPTY ? [blockIdx] : [],
                seedBlockType === BLOCK_EMPTY ? [] : [{ ix: seedIx, iy: seedIy, iz: seedIz }],
                nx,
                ny,
                nz,
                processed,
            );
            componentCount++;
            insertCandidate(candidates, floodResult, limit);
            const [processedLo, processedHi] = getProcessedMask(processed, blockIdx);
            lo = (lo & ~processedLo) >>> 0;
            hi = (hi & ~processedHi) >>> 0;
        }
    }

    const solidBlocks = buffer.getSolidBlocks();
    for (let i = 0; i < solidBlocks.length; i++) {
        const blockIdx = solidBlocks[i];
        const [processedLo, processedHi] = getProcessedMask(processed, blockIdx);
        floodFromMask(blockIdx, (SOLID_LO & ~processedLo) >>> 0, (SOLID_HI & ~processedHi) >>> 0);
    }

    const mixed = buffer.getMixedBlocks();
    for (let i = 0; i < mixed.blockIdx.length; i++) {
        const blockIdx = mixed.blockIdx[i];
        const [processedLo, processedHi] = getProcessedMask(processed, blockIdx);
        floodFromMask(
            blockIdx,
            (mixed.masks[i * 2] & ~processedLo) >>> 0,
            (mixed.masks[i * 2 + 1] & ~processedHi) >>> 0,
        );
    }

    return { candidates, componentCount };
}

function cloneRows(data: SplatData, rows: number[]): SplatData {
    const out = new SplatData().init(rows.length, data.shDegree);
    for (let c = 0; c < data.table.length; c++) {
        const src = data.table[c];
        const dst = out.table[c];
        for (let i = 0; i < rows.length; i++) {
            dst[i] = src[rows[i]];
        }
    }
    return out;
}

export async function filterCluster(
    data: SplatData,
    options: FilterClusterOptions = {},
    runtime: FilterClusterRuntimeOptions = {},
): Promise<SplatData> {
    const backend = runtime.backend ?? 'gpu';
    const voxelResolution = options.voxelResolution ?? 1.0;
    const opacityCutoff = options.opacityCutoff ?? 0.999;
    const minContribution = options.minContribution ?? 0.1;
    const hasExplicitSeed = options.seed !== undefined;
    const seed = options.seed ?? { x: 0, y: 0, z: 0 };
    const box = runtime.box;
    if (!Number.isFinite(voxelResolution) || voxelResolution <= 0) {
        throw new Error(`filterCluster: voxelResolution must be > 0, got ${voxelResolution}`);
    }
    if (!Number.isFinite(opacityCutoff) || opacityCutoff < 0 || opacityCutoff > 1) {
        throw new Error(`filterCluster: opacityCutoff must be in [0, 1], got ${opacityCutoff}`);
    }
    if (!Number.isFinite(minContribution) || minContribution < 0) {
        throw new Error(`filterCluster: minContribution must be >= 0, got ${minContribution}`);
    }
    if (data.counts === 0) {
        return data;
    }
    const table = data.table;
    const xCol = table[ColIdx.x];
    const yCol = table[ColIdx.y];
    const zCol = table[ColIdx.z];
    const sxCol = table[ColIdx.sx];
    const syCol = table[ColIdx.sy];
    const szCol = table[ColIdx.sz];
    const qxCol = table[ColIdx.qx];
    const qyCol = table[ColIdx.qy];
    const qzCol = table[ColIdx.qz];
    const qwCol = table[ColIdx.qw];
    const aCol = table[ColIdx.a];
    const extents = new Float32Array(data.counts * 3);
    const sceneBounds: Bounds = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };
    for (let i = 0; i < data.counts; i++) {
        const e = extentsFromQuatScale(sxCol[i], syCol[i], szCol[i], qxCol[i], qyCol[i], qzCol[i], qwCol[i], aCol[i]);
        extents[i * 3] = e.ex;
        extents[i * 3 + 1] = e.ey;
        extents[i * 3 + 2] = e.ez;
        sceneBounds.min.x = Math.min(sceneBounds.min.x, xCol[i] - e.ex);
        sceneBounds.min.y = Math.min(sceneBounds.min.y, yCol[i] - e.ey);
        sceneBounds.min.z = Math.min(sceneBounds.min.z, zCol[i] - e.ez);
        sceneBounds.max.x = Math.max(sceneBounds.max.x, xCol[i] + e.ex);
        sceneBounds.max.y = Math.max(sceneBounds.max.y, yCol[i] + e.ey);
        sceneBounds.max.z = Math.max(sceneBounds.max.z, zCol[i] + e.ez);
    }
    let gridBounds = alignGridBounds(sceneBounds, voxelResolution);
    if (box) {
        gridBounds = alignGridBounds(
            {
                min: {
                    x: Math.max(gridBounds.min.x, box.minCorner[0]),
                    y: Math.max(gridBounds.min.y, box.minCorner[1]),
                    z: Math.max(gridBounds.min.z, box.minCorner[2]),
                },
                max: {
                    x: Math.min(gridBounds.max.x, box.maxCorner[0]),
                    y: Math.min(gridBounds.max.y, box.maxCorner[1]),
                    z: Math.min(gridBounds.max.z, box.maxCorner[2]),
                },
            },
            voxelResolution,
        );
        if (
            gridBounds.min.x >= gridBounds.max.x ||
            gridBounds.min.y >= gridBounds.max.y ||
            gridBounds.min.z >= gridBounds.max.z
        ) {
            logger.warn('filterCluster: box does not overlap scene bounds, returning empty data');
            return cloneRows(data, []);
        }
    }
    const maxGridExtent = 4096 * voxelResolution;
    function clampAxis(min: number, max: number, seedValue: number) {
        if (max - min <= maxGridExtent) {
            return { min, max };
        }
        const half = maxGridExtent * 0.5;
        const center = Math.max(min + half, Math.min(seedValue, max - half));
        return { min: center - half, max: center + half };
    }
    const cx = clampAxis(gridBounds.min.x, gridBounds.max.x, seed.x);
    const cy = clampAxis(gridBounds.min.y, gridBounds.max.y, seed.y);
    const cz = clampAxis(gridBounds.min.z, gridBounds.max.z, seed.z);
    gridBounds = {
        min: { x: cx.min, y: cy.min, z: cz.min },
        max: { x: cx.max, y: cy.max, z: cz.max },
    };
    const blockSize = 4 * voxelResolution;
    const nbx = Math.round((gridBounds.max.x - gridBounds.min.x) / blockSize);
    const nby = Math.round((gridBounds.max.y - gridBounds.min.y) / blockSize);
    const nbz = Math.round((gridBounds.max.z - gridBounds.min.z) / blockSize);
    const nx = nbx * 4;
    const ny = nby * 4;
    const nz = nbz * 4;
    const cpuOptions: { workerCount?: number; alphaThreshold: number } = { alphaThreshold: 0 };
    if (runtime.cpuWorkerCount !== undefined) {
        cpuOptions.workerCount = runtime.cpuWorkerCount;
    }
    logger.info(
        `filterCluster: backend=${backend}, resolution=${voxelResolution}, opacityCutoff=${opacityCutoff}, ` +
            `minContribution=${minContribution}, grid=${nx}x${ny}x${nz}` +
            (backend === 'cpu'
                ? `, cpuWorkerCount=${cpuOptions.workerCount && cpuOptions.workerCount > 0 ? cpuOptions.workerCount : 'auto'}`
                : ''),
    );
    let buffer: BlockMaskBuffer;
    if (backend === 'gpu') {
        try {
            buffer = await gpuVoxelize(
                xCol,
                yCol,
                zCol,
                sxCol,
                syCol,
                szCol,
                qxCol,
                qyCol,
                qzCol,
                qwCol,
                aCol,
                extents,
                gridBounds,
                voxelResolution,
                opacityCutoff,
            );
        } catch (e) {
            if (e instanceof Error) {
                logger.error(`filterCluster GPU backend failed: ${e.message}`);
                if (e.stack) {
                    logger.error(`filterCluster GPU stack: ${e.stack}`);
                }
            } else {
                logger.error(`filterCluster GPU backend failed: ${String(e)}`);
            }
            logger.error('filterCluster GPU backend failed, fallback to CPU.');
            buffer = await cpuVoxelize(
                xCol,
                yCol,
                zCol,
                sxCol,
                syCol,
                szCol,
                qxCol,
                qyCol,
                qzCol,
                qwCol,
                aCol,
                extents,
                gridBounds,
                voxelResolution,
                opacityCutoff,
                cpuOptions,
            );
        }
    } else {
        buffer = await cpuVoxelize(
            xCol,
            yCol,
            zCol,
            sxCol,
            syCol,
            szCol,
            qxCol,
            qyCol,
            qzCol,
            qwCol,
            aCol,
            extents,
            gridBounds,
            voxelResolution,
            opacityCutoff,
            cpuOptions,
        );
    }
    if (buffer.count === 0) {
        logger.warn('filterCluster: no occupied voxels, returning empty data');
        return cloneRows(data, []);
    }
    const occupied = SparseVoxelGrid.fromBuffer(buffer, nx, ny, nz);
    const blocked = occupied.cropToInverted(0, 0, 0, occupied.nbx, occupied.nby, occupied.nbz);
    const seedIx = Math.max(0, Math.min(Math.floor((seed.x - gridBounds.min.x) / voxelResolution), nx - 1));
    const seedIy = Math.max(0, Math.min(Math.floor((seed.y - gridBounds.min.y) / voxelResolution), ny - 1));
    const seedIz = Math.max(0, Math.min(Math.floor((seed.z - gridBounds.min.z) / voxelResolution), nz - 1));
    const seedCluster = floodClusterFromSeed(blocked, nx, ny, nz, seedIx, seedIy, seedIz);
    if (!seedCluster) {
        logger.warn('filterCluster: no occupied voxel near seed, returning empty data');
        return cloneRows(data, []);
    }

    const blockGrid: BlockGridParams = {
        gridMinX: gridBounds.min.x,
        gridMinY: gridBounds.min.y,
        gridMinZ: gridBounds.min.z,
        blockSize,
        voxelResolution,
        numBlocksX: nbx,
        numBlocksY: nby,
        numBlocksZ: nbz,
        strideY: nbx,
        strideZ: nbx * nby,
    };
    const largeThreshold = 2 * voxelResolution;
    const minOccupancyRatio = 0.1;
    const invVoxel = 1 / voxelResolution;

    function selectGaussiansForCluster(
        clusterBuffer: BlockMaskBuffer,
        keepCountToExceed?: number,
    ): GaussianSelectionResult {
        const lookup = buildBlockLookup(clusterBuffer);
        const selectedIndices: number[] = [];
        for (let i = 0; i < data.counts; i++) {
            const remaining = data.counts - i;
            if (keepCountToExceed !== undefined && selectedIndices.length + remaining <= keepCountToExceed) {
                return {
                    selectedIndices,
                    aborted: true,
                };
            }
            if (isCenterInOccupiedVoxel(xCol[i], yCol[i], zCol[i], blockGrid, lookup)) {
                selectedIndices.push(i);
                continue;
            }
            const ex = extents[i * 3];
            const ey = extents[i * 3 + 1];
            const ez = extents[i * 3 + 2];
            let minHits = 1;
            if (Math.max(ex, ey, ez) * 2 > largeThreshold) {
                const aabbVoxels = 2 * ex * invVoxel * (2 * ey * invVoxel) * (2 * ez * invVoxel);
                minHits = Math.max(1, Math.ceil(aabbVoxels * minOccupancyRatio));
            }
            if (gaussianContributesToVoxels(i, data, extents, blockGrid, lookup, minContribution, minHits)) {
                selectedIndices.push(i);
            }
        }
        return {
            selectedIndices,
            aborted: false,
        };
    }

    const seedClusterBuffer = seedCluster.grid.toBuffer(0, 0, 0, nbx, nby, nbz);
    if (seedClusterBuffer.count === buffer.count) {
        const occupiedVoxelCount = countOccupiedVoxels(buffer);
        if (seedCluster.voxelCount === occupiedVoxelCount) {
            logger.info('filterCluster: all occupied voxels are connected, no filtering needed');
            return data;
        }
        logger.info(
            `filterCluster: all occupied blocks reached but voxel count differs ` +
                `(cluster=${seedCluster.voxelCount}, occupied=${occupiedVoxelCount}); continuing filtering`,
        );
    }

    let chosenIndices = selectGaussiansForCluster(seedClusterBuffer).selectedIndices;
    let chosenSource = 'seed';
    let chosenKeepRatio = chosenIndices.length / data.counts;

    if (hasExplicitSeed && chosenKeepRatio < FALLBACK_MIN_GAUSSIAN_RATIO) {
        logger.warn(
            `filterCluster: explicit seed cluster keeps ${chosenIndices.length}/${data.counts} gaussians ` +
                `(${(chosenKeepRatio * 100).toFixed(1)}%); automatic fallback is disabled for explicit seeds`,
        );
    }

    if (!hasExplicitSeed && chosenKeepRatio < FALLBACK_MIN_GAUSSIAN_RATIO) {
        logger.warn(
            `filterCluster: default seed cluster keeps ${chosenIndices.length}/${data.counts} gaussians ` +
                `(${(chosenKeepRatio * 100).toFixed(1)}%), ` +
                `below the fallback threshold (${(FALLBACK_MIN_GAUSSIAN_RATIO * 100).toFixed(1)}%); ` +
                'falling back to connected-component search',
        );
        const { candidates, componentCount } = findLargestVoxelClusterCandidates(
            buffer,
            blocked,
            nx,
            ny,
            nz,
            FALLBACK_CANDIDATE_LIMIT,
            seedCluster.grid,
            1,
        );
        logger.info(
            `filterCluster fallback: components=${componentCount}, candidates=${candidates.length}, ` +
                `candidateLimit=${FALLBACK_CANDIDATE_LIMIT}`,
        );
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            const candidateClusterBuffer = candidate.grid.toBuffer(0, 0, 0, nbx, nby, nbz);
            const candidateSelection = selectGaussiansForCluster(candidateClusterBuffer, chosenIndices.length);
            if (candidateSelection.aborted) {
                continue;
            }
            const candidateKeepRatio = candidateSelection.selectedIndices.length / data.counts;
            if (candidateSelection.selectedIndices.length > chosenIndices.length) {
                chosenIndices = candidateSelection.selectedIndices;
                chosenKeepRatio = candidateKeepRatio;
                chosenSource = `fallback candidate #${i + 1}`;
            }
        }
        for (const candidate of candidates) {
            candidate.grid.releaseStorage();
        }
    }

    logger.info(
        `filterCluster: kept ${chosenIndices.length} / ${data.counts} gaussians via ${chosenSource} ` +
            `(${(chosenKeepRatio * 100).toFixed(1)}%)`,
    );
    return chosenIndices.length === data.counts ? data : cloneRows(data, chosenIndices);
}
