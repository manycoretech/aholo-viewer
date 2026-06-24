import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { constants as zlibConstants, gzipSync, zstdCompressSync } from 'node:zlib';

/**
 * Portions of this voxel pipeline are adapted from:
 * https://github.com/playcanvas/splat-transform
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 * Licensed under the MIT License.
 */
import { ColIdx, type SplatData } from '../SplatData.js';
import { computeDenseBox, logger, cpuVoxelize, gpuVoxelize, type BlockMaskBuffer } from '../utils/index.js';
import { encodeCompactVoxelBinary, encodeRawVoxelBinary, type VoxelNodeEncoding } from '../utils/voxel/binary.js';
import { fillExterior, fillFloor, carve, type NavSeed } from '../utils/voxel/nav.js';
import { buildCollisionMesh, type CollisionMeshShape } from '../utils/voxel/mesh.js';
import { cropToNavigable, cropToOccupied, filterAndFillBlocks } from '../utils/voxel/postprocess.js';
import {
    filterCluster,
    type FilterClusterOptions,
    type FilterClusterRuntimeOptions,
} from '../utils/voxel/filter-cluster.js';
import {
    alignGridBounds,
    ALPHA_THRESHOLD,
    buildSparseOctree,
    checkVoxelGridCapacity,
    decodeMorton3,
    encodeMorton3,
    extentsFromQuatScale,
    getChildOffset,
    MAX_24BIT_OFFSET,
    MAX_VOXEL_BLOCK_COUNT_INT32,
    SparseOctree24BitOverflowError,
    SparseVoxelGrid,
    type Bounds,
    type SparseOctree,
} from '../utils/voxel/common.js';
export type VoxelBinaryCompression = 'none' | 'gzip' | 'zstd';

interface VoxelMetadata {
    version: string;
    gridBounds: { min: number[]; max: number[] };
    sceneBounds: { min: number[]; max: number[] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
    files: string[];
    nodeEncoding: VoxelNodeEncoding;
    compression: VoxelBinaryCompression;
}
type VoxelBackend = 'cpu' | 'gpu';
type CollisionMeshOption = boolean | CollisionMeshShape;
interface BoundsBox {
    minCorner: [number, number, number];
    maxCorner: [number, number, number];
}
export interface AutoDenseBoxOptions {
    targetCenterKeepRatio?: number;
    minimumCenterKeepRatio?: number;
    minimumAxisInflation?: number;
    minimumVolumeInflation?: number;
}
export type AutoDenseBoxConfig = boolean | AutoDenseBoxOptions;
interface VoxelWriteResult {
    metadata: VoxelMetadata;
    binary: Uint8Array;
    collisionGlb: Uint8Array | undefined;
}
interface VoxelBinaryOutput {
    filename: string;
    payload: Uint8Array;
}
// Stay under the hard 31-bit block limit and leave room for CPU memory use.
const GRID_BLOCK_FALLBACK_TARGET = Math.floor(MAX_VOXEL_BLOCK_COUNT_INT32 * 0.55);
const OCTREE_24BIT_FALLBACK_TARGET = Math.floor((MAX_24BIT_OFFSET + 1) * 0.98);
const MAX_RESOLUTION_FALLBACK_ATTEMPTS = 4;
const RESOLUTION_FALLBACK_ALIGNMENT = 0.01;
const ZSTD_COMPRESSION_LEVEL = 12;
const DEFAULT_VOXEL_BOX: BoundsBox = { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] };
const DEFAULT_AUTO_DENSE_BOX_TARGET_CENTER_KEEP_RATIO = 0.98;
const DEFAULT_AUTO_DENSE_BOX_MINIMUM_CENTER_KEEP_RATIO = 0.95;
const DEFAULT_AUTO_DENSE_BOX_MINIMUM_AXIS_INFLATION = 1.5;
const DEFAULT_AUTO_DENSE_BOX_MINIMUM_VOLUME_INFLATION = 4;

function blockCountFromBounds(bounds: Bounds, voxelResolution: number) {
    const blockSize = 4 * voxelResolution;
    const count = {
        x: Math.round((bounds.max.x - bounds.min.x) / blockSize),
        y: Math.round((bounds.max.y - bounds.min.y) / blockSize),
        z: Math.round((bounds.max.z - bounds.min.z) / blockSize),
    };
    return { ...count, total: count.x * count.y * count.z };
}

function chooseFallbackResolution(currentVoxelResolution: number, currentCount: number, targetCount: number): number {
    // Raise resolution based on how far the count is over target.
    // Round up to 0.01 so metadata stays easy to read.
    const step = RESOLUTION_FALLBACK_ALIGNMENT;
    function align(value: number) {
        return Number((Math.ceil((value - 1e-12) / step) * step).toFixed(6));
    }
    const scaled = currentVoxelResolution * Math.cbrt(currentCount / targetCount);
    const aligned = align(scaled);
    if (aligned > currentVoxelResolution) {
        return aligned;
    }
    return align(currentVoxelResolution + step);
}

function formatBoundsBox(box: BoundsBox) {
    const formatPoint = (point: [number, number, number]) => point.map(v => v.toFixed(2)).join(',');
    return `(${formatPoint(box.minCorner)})-(${formatPoint(box.maxCorner)})`;
}

function toBoundsBox(box: { min: number[]; max: number[] }): BoundsBox {
    return {
        minCorner: [box.min[0], box.min[1], box.min[2]],
        maxCorner: [box.max[0], box.max[1], box.max[2]],
    };
}

function intersectBoundsBoxes(a: BoundsBox, b: BoundsBox): BoundsBox | null {
    const minCorner: [number, number, number] = [
        Math.max(a.minCorner[0], b.minCorner[0]),
        Math.max(a.minCorner[1], b.minCorner[1]),
        Math.max(a.minCorner[2], b.minCorner[2]),
    ];
    const maxCorner: [number, number, number] = [
        Math.min(a.maxCorner[0], b.maxCorner[0]),
        Math.min(a.maxCorner[1], b.maxCorner[1]),
        Math.min(a.maxCorner[2], b.maxCorner[2]),
    ];
    if (minCorner[0] >= maxCorner[0] || minCorner[1] >= maxCorner[1] || minCorner[2] >= maxCorner[2]) {
        return null;
    }
    return { minCorner, maxCorner };
}

function countCentersInsideBounds(data: SplatData, box: BoundsBox) {
    const xCol = data.table[ColIdx.x];
    const yCol = data.table[ColIdx.y];
    const zCol = data.table[ColIdx.z];
    const [minX, minY, minZ] = box.minCorner;
    const [maxX, maxY, maxZ] = box.maxCorner;
    let count = 0;
    for (let i = 0; i < data.counts; i++) {
        if (
            xCol[i] >= minX &&
            xCol[i] <= maxX &&
            yCol[i] >= minY &&
            yCol[i] <= maxY &&
            zCol[i] >= minZ &&
            zCol[i] <= maxZ
        ) {
            count++;
        }
    }
    return count;
}

function computeCenterAndSceneBounds(data: SplatData): { centerBounds: BoundsBox; sceneBounds: BoundsBox } {
    if (data.counts === 0) {
        return {
            centerBounds: { minCorner: [0, 0, 0], maxCorner: [0, 0, 0] },
            sceneBounds: { minCorner: [0, 0, 0], maxCorner: [0, 0, 0] },
        };
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

    const centerBounds: BoundsBox = {
        minCorner: [Infinity, Infinity, Infinity],
        maxCorner: [-Infinity, -Infinity, -Infinity],
    };
    const sceneBounds: BoundsBox = {
        minCorner: [Infinity, Infinity, Infinity],
        maxCorner: [-Infinity, -Infinity, -Infinity],
    };

    for (let i = 0; i < data.counts; i++) {
        const x = xCol[i];
        const y = yCol[i];
        const z = zCol[i];
        const e = extentsFromQuatScale(sxCol[i], syCol[i], szCol[i], qxCol[i], qyCol[i], qzCol[i], qwCol[i], aCol[i]);
        const ex = Number.isFinite(e.ex) ? e.ex : 0;
        const ey = Number.isFinite(e.ey) ? e.ey : 0;
        const ez = Number.isFinite(e.ez) ? e.ez : 0;

        centerBounds.minCorner[0] = Math.min(centerBounds.minCorner[0], x);
        centerBounds.minCorner[1] = Math.min(centerBounds.minCorner[1], y);
        centerBounds.minCorner[2] = Math.min(centerBounds.minCorner[2], z);
        centerBounds.maxCorner[0] = Math.max(centerBounds.maxCorner[0], x);
        centerBounds.maxCorner[1] = Math.max(centerBounds.maxCorner[1], y);
        centerBounds.maxCorner[2] = Math.max(centerBounds.maxCorner[2], z);

        sceneBounds.minCorner[0] = Math.min(sceneBounds.minCorner[0], x - ex);
        sceneBounds.minCorner[1] = Math.min(sceneBounds.minCorner[1], y - ey);
        sceneBounds.minCorner[2] = Math.min(sceneBounds.minCorner[2], z - ez);
        sceneBounds.maxCorner[0] = Math.max(sceneBounds.maxCorner[0], x + ex);
        sceneBounds.maxCorner[1] = Math.max(sceneBounds.maxCorner[1], y + ey);
        sceneBounds.maxCorner[2] = Math.max(sceneBounds.maxCorner[2], z + ez);
    }

    return { centerBounds, sceneBounds };
}

function getBoundsInflation(centerBounds: BoundsBox, sceneBounds: BoundsBox) {
    const centerX = Math.max(0, centerBounds.maxCorner[0] - centerBounds.minCorner[0]);
    const centerY = Math.max(0, centerBounds.maxCorner[1] - centerBounds.minCorner[1]);
    const centerZ = Math.max(0, centerBounds.maxCorner[2] - centerBounds.minCorner[2]);
    const sceneX = Math.max(0, sceneBounds.maxCorner[0] - sceneBounds.minCorner[0]);
    const sceneY = Math.max(0, sceneBounds.maxCorner[1] - sceneBounds.minCorner[1]);
    const sceneZ = Math.max(0, sceneBounds.maxCorner[2] - sceneBounds.minCorner[2]);
    const axisInflation = Math.max(
        sceneX / Math.max(centerX, 1e-6),
        sceneY / Math.max(centerY, 1e-6),
        sceneZ / Math.max(centerZ, 1e-6),
    );
    const sceneVolume = sceneX * sceneY * sceneZ;
    const centerVolume = centerX * centerY * centerZ;
    const volumeInflation = sceneVolume / Math.max(centerVolume, 1e-6);
    return { axisInflation, volumeInflation };
}

function resolveAutoDenseBoxOptions(autoDenseBox?: AutoDenseBoxConfig): Required<AutoDenseBoxOptions> | null {
    if (!autoDenseBox) {
        return null;
    }
    const options = autoDenseBox === true ? {} : autoDenseBox;
    const targetCenterKeepRatio = options.targetCenterKeepRatio ?? DEFAULT_AUTO_DENSE_BOX_TARGET_CENTER_KEEP_RATIO;
    const minimumCenterKeepRatio = options.minimumCenterKeepRatio ?? DEFAULT_AUTO_DENSE_BOX_MINIMUM_CENTER_KEEP_RATIO;
    const minimumAxisInflation = options.minimumAxisInflation ?? DEFAULT_AUTO_DENSE_BOX_MINIMUM_AXIS_INFLATION;
    const minimumVolumeInflation = options.minimumVolumeInflation ?? DEFAULT_AUTO_DENSE_BOX_MINIMUM_VOLUME_INFLATION;
    return {
        targetCenterKeepRatio,
        minimumCenterKeepRatio,
        minimumAxisInflation,
        minimumVolumeInflation,
    };
}

function resolveVoxelBox(data: SplatData, baseBox: BoundsBox, autoDenseBox?: AutoDenseBoxConfig): BoundsBox {
    const autoDenseBoxOptions = resolveAutoDenseBoxOptions(autoDenseBox);
    if (!autoDenseBoxOptions || data.counts === 0) {
        return baseBox;
    }

    const { centerBounds, sceneBounds } = computeCenterAndSceneBounds(data);
    const { axisInflation, volumeInflation } = getBoundsInflation(centerBounds, sceneBounds);
    const shouldTryDenseBox =
        axisInflation >= autoDenseBoxOptions.minimumAxisInflation ||
        volumeInflation >= autoDenseBoxOptions.minimumVolumeInflation;
    if (!shouldTryDenseBox) {
        logger.info(
            `voxel autoDenseBox skipped: bounds inflation is small ` +
                `(axis=${axisInflation.toFixed(2)}x, volume=${volumeInflation.toFixed(2)}x)`,
        );
        return baseBox;
    }

    const denseBoxTrimRatio = 1 - autoDenseBoxOptions.targetCenterKeepRatio;
    const denseBox = toBoundsBox(computeDenseBox(data, denseBoxTrimRatio));
    const clippedDenseBox = intersectBoundsBoxes(baseBox, denseBox);
    if (!clippedDenseBox) {
        logger.warn(
            `voxel autoDenseBox skipped: dense box ${formatBoundsBox(denseBox)} does not overlap base box ${formatBoundsBox(baseBox)}`,
        );
        return baseBox;
    }

    const centerKeepCount = countCentersInsideBounds(data, clippedDenseBox);
    const centerKeepRatio = centerKeepCount / data.counts;
    if (centerKeepRatio < autoDenseBoxOptions.minimumCenterKeepRatio) {
        logger.warn(
            `voxel autoDenseBox skipped: dense box keeps ${centerKeepCount}/${data.counts} centers ` +
                `(${(centerKeepRatio * 100).toFixed(1)}%), below minimum ` +
                `${(autoDenseBoxOptions.minimumCenterKeepRatio * 100).toFixed(1)}%`,
        );
        return baseBox;
    }

    logger.info(
        `voxel autoDenseBox applied: bounds inflation axis=${axisInflation.toFixed(2)}x, ` +
            `volume=${volumeInflation.toFixed(2)}x; center keep=${centerKeepCount}/${data.counts} ` +
            `(${(centerKeepRatio * 100).toFixed(1)}%); box=${formatBoundsBox(clippedDenseBox)}`,
    );
    return clippedDenseBox;
}

function compressVoxelBinary(binary: Uint8Array, compression: VoxelBinaryCompression): VoxelBinaryOutput {
    switch (compression) {
        case 'none':
            return { filename: 'voxel.bin', payload: binary };
        case 'gzip':
            return { filename: 'voxel.bin.gz', payload: gzipSync(binary) };
        case 'zstd':
            return {
                filename: 'voxel.bin.zst',
                payload: zstdCompressSync(binary, {
                    params: {
                        [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL,
                    },
                }),
            };
    }
    throw new Error(`Invalid voxel compression: ${String(compression)}`);
}

function formatCompressedSizePercent(rawBytes: number, compressedBytes: number) {
    return rawBytes > 0 ? ((compressedBytes / rawBytes) * 100).toFixed(1) : 'n/a';
}

/**
 * Build a sparse voxel octree from gaussian splat data.
 *
 * Pipeline (based on https://github.com/playcanvas/splat-transform/blob/8f3b843efdc378f97d4f6a66a3a90a2de6d479a4/src/lib/writers/write-voxel.ts):
 * 1) Compute gaussian extents and scene bounds (`extentsFromQuatScale`).
 * 2) Align grid bounds.
 * 3) Voxelize to `BlockMaskBuffer` via `gpuVoxelize`.
 * 4) Post-process occupancy (`filterAndFillBlocks`, optional `fillExterior`, `fillFloor`, `carve`).
 * 5) Crop bounds (`cropToNavigable` or `cropToOccupied`), then build octree (`buildSparseOctree`).
 * 6) Optionally generate collision mesh (`buildCollisionMesh` → `collision.glb` next to `voxel.bin`).
 *
 * @param data - Gaussian splat source data.
 * @param voxelResolution - Voxel size in world units.
 * @param opacityCutoff - Opacity threshold used during voxelization.
 * @param collisionMesh - Whether to generate collision GLB.
 * @param navExteriorRadius - Exterior fill radius; requires `navSeed`.
 * @param floorFill - Whether to run floor fill before carve.
 * @param floorFillDilation - Horizontal dilation radius for floor fill.
 * @param box - Axis-aligned world-space clamp box for voxelization.
 * @param navCapsule - Capsule config used by `carve`.
 * @param navSeed - Seed position used by exterior/carve flood fills.
 */
async function writeVoxels(
    data: SplatData,
    voxelResolution = 0.05,
    opacityCutoff = 0.1,
    backend: VoxelBackend = 'gpu',
    collisionMesh: CollisionMeshOption = false,
    navExteriorRadius?: number,
    floorFill = false,
    floorFillDilation = 0,
    cpuWorkerCount = -1,
    box: BoundsBox = { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] },
    navCapsule?: { height: number; radius: number },
    navSeed?: NavSeed,
    nodeEncoding: VoxelNodeEncoding = 'raw',
    compression: VoxelBinaryCompression = 'none',
    requestedVoxelResolution = voxelResolution,
): Promise<VoxelWriteResult> {
    const hasNav = !!(navCapsule && navSeed && navCapsule.height > 0);
    const hasFillExterior = !!(navExteriorRadius && navSeed);
    const hasFloorFill = floorFill;
    logger.info(
        `voxel params: resolution=${voxelResolution}, opacityCutoff=${opacityCutoff}, backend=${backend}, ` +
            `collisionMesh=${collisionMesh}, navExteriorRadius=${navExteriorRadius ?? 'none'}, ` +
            `floorFill=${floorFill}, floorFillDilation=${floorFillDilation}, cpuWorkerCount=${cpuWorkerCount === -1 ? 'auto' : cpuWorkerCount}, ` +
            `box=${JSON.stringify(box)}, navCapsule=${navCapsule ? JSON.stringify(navCapsule) : 'none'}, ` +
            `navSeed=${navSeed ? JSON.stringify(navSeed) : 'none'}, hasFillExterior=${hasFillExterior}, hasFloorFill=${hasFloorFill}, hasNav=${hasNav}`,
    );
    const xCol = data.table[ColIdx.x];
    const yCol = data.table[ColIdx.y];
    const zCol = data.table[ColIdx.z];
    const sxCol = data.table[ColIdx.sx];
    const syCol = data.table[ColIdx.sy];
    const szCol = data.table[ColIdx.sz];
    const qxCol = data.table[ColIdx.qx];
    const qyCol = data.table[ColIdx.qy];
    const qzCol = data.table[ColIdx.qz];
    const qwCol = data.table[ColIdx.qw];
    const aCol = data.table[ColIdx.a];

    const sceneBounds: Bounds = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };

    // Compute per-gaussian AABB extents from quaternion+scale and accumulate scene bounds.
    logger.time('Voxel bounding/extents');
    const extents = new Float32Array(data.counts * 3);
    const extentOpacityThreshold = ALPHA_THRESHOLD;
    let invalidExtentCount = 0;
    for (let i = 0; i < data.counts; i++) {
        const e = extentsFromQuatScale(
            sxCol[i],
            syCol[i],
            szCol[i],
            qxCol[i],
            qyCol[i],
            qzCol[i],
            qwCol[i],
            aCol[i],
            extentOpacityThreshold,
        );
        if (!Number.isFinite(e.ex) || !Number.isFinite(e.ey) || !Number.isFinite(e.ez)) {
            extents[i * 3 + 0] = 0;
            extents[i * 3 + 1] = 0;
            extents[i * 3 + 2] = 0;
            invalidExtentCount++;
        } else {
            extents[i * 3 + 0] = e.ex;
            extents[i * 3 + 1] = e.ey;
            extents[i * 3 + 2] = e.ez;
            sceneBounds.min.x = Math.min(sceneBounds.min.x, xCol[i] - e.ex);
            sceneBounds.min.y = Math.min(sceneBounds.min.y, yCol[i] - e.ey);
            sceneBounds.min.z = Math.min(sceneBounds.min.z, zCol[i] - e.ez);
            sceneBounds.max.x = Math.max(sceneBounds.max.x, xCol[i] + e.ex);
            sceneBounds.max.y = Math.max(sceneBounds.max.y, yCol[i] + e.ey);
            sceneBounds.max.z = Math.max(sceneBounds.max.z, zCol[i] + e.ez);
        }
    }
    if (invalidExtentCount > 0) {
        logger.info(`voxel: skipped ${invalidExtentCount} gaussians with invalid extent values`);
    }
    logger.info(
        `scene extents: (${sceneBounds.min.x.toFixed(2)},${sceneBounds.min.y.toFixed(2)},${sceneBounds.min.z.toFixed(2)}) - (${sceneBounds.max.x.toFixed(2)},${sceneBounds.max.y.toFixed(2)},${sceneBounds.max.z.toFixed(2)})`,
    );
    logger.timeEnd('Voxel bounding/extents');

    function resolveVoxelBounds(resolution: number) {
        const exteriorPad = hasFillExterior ? (Math.ceil(navExteriorRadius! / resolution) + 1) * resolution : 0;
        const floorPad = hasFloorFill ? (Math.ceil(floorFillDilation / resolution) + 1) * resolution : 0;
        const padXZ = Math.max(exteriorPad, floorPad);
        const padY = exteriorPad;
        const rawVoxelBounds: Bounds = {
            min: {
                x: sceneBounds.min.x - padXZ,
                y: sceneBounds.min.y - padY,
                z: sceneBounds.min.z - padXZ,
            },
            max: {
                x: sceneBounds.max.x + padXZ,
                y: sceneBounds.max.y + padY,
                z: sceneBounds.max.z + padXZ,
            },
        };
        const voxelBounds: Bounds = {
            min: {
                x: Math.max(rawVoxelBounds.min.x, box.minCorner[0]),
                y: Math.max(rawVoxelBounds.min.y, box.minCorner[1]),
                z: Math.max(rawVoxelBounds.min.z, box.minCorner[2]),
            },
            max: {
                x: Math.min(rawVoxelBounds.max.x, box.maxCorner[0]),
                y: Math.min(rawVoxelBounds.max.y, box.maxCorner[1]),
                z: Math.min(rawVoxelBounds.max.z, box.maxCorner[2]),
            },
        };
        return { rawVoxelBounds, voxelBounds, gridBounds: alignGridBounds(voxelBounds, resolution) };
    }

    let bounds = resolveVoxelBounds(voxelResolution);
    let blockCount = blockCountFromBounds(bounds.gridBounds, voxelResolution);
    for (let attempt = 0; blockCount.total > GRID_BLOCK_FALLBACK_TARGET; attempt++) {
        if (attempt >= MAX_RESOLUTION_FALLBACK_ATTEMPTS) {
            break;
        }
        const nextVoxelResolution = chooseFallbackResolution(
            voxelResolution,
            blockCount.total,
            GRID_BLOCK_FALLBACK_TARGET,
        );
        const detail = `grid blocks=${blockCount.x}x${blockCount.y}x${blockCount.z}, total=${blockCount.total}, target=${GRID_BLOCK_FALLBACK_TARGET}`;
        logger.info(
            `voxel resolution fallback: ${detail}; ` + `resolution ${voxelResolution} -> ${nextVoxelResolution}`,
        );
        voxelResolution = nextVoxelResolution;
        bounds = resolveVoxelBounds(voxelResolution);
        blockCount = blockCountFromBounds(bounds.gridBounds, voxelResolution);
    }

    const { rawVoxelBounds, voxelBounds } = bounds;
    const gridBounds = bounds.gridBounds;
    const boxCropApplied =
        voxelBounds.min.x > rawVoxelBounds.min.x ||
        voxelBounds.min.y > rawVoxelBounds.min.y ||
        voxelBounds.min.z > rawVoxelBounds.min.z ||
        voxelBounds.max.x < rawVoxelBounds.max.x ||
        voxelBounds.max.y < rawVoxelBounds.max.y ||
        voxelBounds.max.z < rawVoxelBounds.max.z;
    if (boxCropApplied) {
        logger.info(
            `voxel box crop applied: ` +
                `raw=(${rawVoxelBounds.min.x.toFixed(2)},${rawVoxelBounds.min.y.toFixed(2)},${rawVoxelBounds.min.z.toFixed(2)})-` +
                `(${rawVoxelBounds.max.x.toFixed(2)},${rawVoxelBounds.max.y.toFixed(2)},${rawVoxelBounds.max.z.toFixed(2)}), ` +
                `cropped=(${voxelBounds.min.x.toFixed(2)},${voxelBounds.min.y.toFixed(2)},${voxelBounds.min.z.toFixed(2)})-` +
                `(${voxelBounds.max.x.toFixed(2)},${voxelBounds.max.y.toFixed(2)},${voxelBounds.max.z.toFixed(2)})`,
        );
    }
    if (
        voxelBounds.min.x >= voxelBounds.max.x ||
        voxelBounds.min.y >= voxelBounds.max.y ||
        voxelBounds.min.z >= voxelBounds.max.z
    ) {
        throw new Error(`voxel box does not overlap scene bounds: box=${JSON.stringify(box)}`);
    }
    if (voxelResolution !== requestedVoxelResolution) {
        logger.info(`voxel effective resolution=${voxelResolution} (requested=${requestedVoxelResolution})`);
    }
    checkVoxelGridCapacity(gridBounds, voxelResolution);

    let blocks: BlockMaskBuffer | undefined;
    if (backend === 'gpu') {
        const gpuStart = Date.now();
        try {
            blocks = await gpuVoxelize(
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
            const gpuElapsed = Date.now() - gpuStart;
            logger.info(`Voxelizing (GPU) done: ${(gpuElapsed / 1000).toFixed(3)}s`);
        } catch (e) {
            const gpuElapsed = Date.now() - gpuStart;
            logger.error(`Voxelizing (GPU) failed after ${(gpuElapsed / 1000).toFixed(3)}s`);
            if (e instanceof Error) {
                logger.error(`GPU error message: ${e.message}`);
                if (e.stack) {
                    logger.error(`GPU error stack: ${e.stack}`);
                }
            } else {
                logger.error(`GPU error: ${String(e)}`);
            }
            logger.error('Voxel GPU backend failed, fallback to CPU.');
        }
    }
    if (!blocks || blocks.count === 0) {
        logger.time('Voxelizing (CPU)');
        blocks = await cpuVoxelize(
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
            { workerCount: cpuWorkerCount },
        );
        logger.timeEnd('Voxelizing (CPU)');
    }
    // Remove isolated noise voxels and fill tiny holes at block-mask level.
    logger.time('Filter blocks');
    const blockSize = 4 * voxelResolution;
    const numBlocksX = Math.round((gridBounds.max.x - gridBounds.min.x) / blockSize);
    const numBlocksY = Math.round((gridBounds.max.y - gridBounds.min.y) / blockSize);
    const numBlocksZ = Math.round((gridBounds.max.z - gridBounds.min.z) / blockSize);
    blocks = filterAndFillBlocks(blocks, numBlocksX, numBlocksY, numBlocksZ);
    logger.timeEnd('Filter blocks');

    logger.time('Loading grid');
    let grid = SparseVoxelGrid.fromBuffer(blocks, numBlocksX << 2, numBlocksY << 2, numBlocksZ << 2);
    blocks.clear();
    logger.timeEnd('Loading grid');

    let navGridBounds = gridBounds;
    // Optional navigability passes (aligned with reference order):
    // fillExterior -> fillFloor -> carve.
    if (hasFillExterior) {
        logger.time('Fill exterior');
        const fillResult = await fillExterior(
            grid,
            navGridBounds,
            voxelResolution,
            navExteriorRadius!,
            navSeed!,
            backend,
        );
        grid = fillResult.grid;
        navGridBounds = fillResult.gridBounds;
        logger.timeEnd('Fill exterior');
    }
    if (hasFloorFill) {
        logger.time('Fill floor');
        const floorResult = await fillFloor(grid, navGridBounds, voxelResolution, floorFillDilation, backend);
        grid = floorResult.grid;
        navGridBounds = floorResult.gridBounds;
        logger.timeEnd('Fill floor');
    }
    if (hasNav) {
        logger.time('Carve nav');
        const navResult = await carve(
            grid,
            navGridBounds,
            voxelResolution,
            navCapsule!.height,
            navCapsule!.radius,
            navSeed!,
            backend,
        );
        grid = navResult.grid;
        navGridBounds = navResult.gridBounds;
        logger.timeEnd('Carve nav');
    }
    // Crop padded bounds before octree build.
    // If navigability passes ran, keep navigable extent; otherwise crop to occupied extent.
    logger.time('Crop voxel bounds');
    const finalCrop =
        hasFillExterior || hasFloorFill
            ? cropToNavigable(grid, navGridBounds, voxelResolution)
            : cropToOccupied(grid, navGridBounds, voxelResolution);
    grid = finalCrop.grid;
    navGridBounds = finalCrop.gridBounds;
    logger.timeEnd('Crop voxel bounds');

    function resolveCollisionMeshShape() {
        if (collisionMesh === false || collisionMesh === undefined) {
            return null;
        }
        if (collisionMesh === true) {
            return 'smooth' as const;
        }
        if (collisionMesh === 'smooth' || collisionMesh === 'faces') {
            return collisionMesh;
        }
        throw new Error(
            `Invalid collisionMesh value: ${String(collisionMesh)}. Expected true, false, "smooth", or "faces"`,
        );
    }
    const collisionMeshShape = resolveCollisionMeshShape();
    const collisionGlb = collisionMeshShape
        ? buildCollisionMesh(grid, navGridBounds, voxelResolution, collisionMeshShape)
        : undefined;

    // BuildSparseOctree emits Laine-Karras nodes + mixed leaf masks.
    logger.time('Build octree');
    let octree: SparseOctree;
    try {
        octree = buildSparseOctree(grid, navGridBounds, sceneBounds, voxelResolution, { consumeGrid: true });
        logger.timeEnd('Build octree');
    } catch (error) {
        logger.timeEnd('Build octree');
        if (error instanceof SparseOctree24BitOverflowError) {
            error.voxelResolution = voxelResolution;
        }
        throw error;
    }
    logger.info(
        `octree: depth=${octree.treeDepth}, interior=${octree.numInteriorNodes}, mixed=${octree.numMixedLeaves}`,
    );
    const metadata: VoxelMetadata = {
        version: '1.2',
        gridBounds: {
            min: [octree.gridBounds.min.x, octree.gridBounds.min.y, octree.gridBounds.min.z],
            max: [octree.gridBounds.max.x, octree.gridBounds.max.y, octree.gridBounds.max.z],
        },
        sceneBounds: {
            min: [octree.sceneBounds.min.x, octree.sceneBounds.min.y, octree.sceneBounds.min.z],
            max: [octree.sceneBounds.max.x, octree.sceneBounds.max.y, octree.sceneBounds.max.z],
        },
        voxelResolution: octree.voxelResolution,
        leafSize: octree.leafSize,
        treeDepth: octree.treeDepth,
        numInteriorNodes: octree.numInteriorNodes,
        numMixedLeaves: octree.numMixedLeaves,
        nodeCount: octree.nodes.length,
        leafDataCount: octree.leafData.length,
        files: ['voxel.bin'],
        nodeEncoding,
        compression,
    };
    const binary =
        nodeEncoding === 'compact'
            ? encodeCompactVoxelBinary(octree.nodes, octree.leafData, octree.numInteriorNodes, octree.numMixedLeaves)
            : encodeRawVoxelBinary(octree.nodes, octree.leafData);

    return { metadata, binary, collisionGlb };
}

export async function writeVoxelFiles(
    outputDir: string,
    data: SplatData,
    options?: {
        voxelResolution?: number;
        opacityCutoff?: number;
        backend?: VoxelBackend;
        collisionMesh?: CollisionMeshOption;
        navExteriorRadius?: number;
        floorFill?: boolean;
        floorFillDilation?: number;
        cpuWorkerCount?: number;
        box?: BoundsBox;
        navCapsule?: { height: number; radius: number };
        navSeed?: NavSeed;
        compression?: VoxelBinaryCompression;
        nodeEncoding?: VoxelNodeEncoding;
        filterCluster?: boolean | FilterClusterOptions;
        autoDenseBox?: AutoDenseBoxConfig;
    },
) {
    const compression = options?.compression ?? 'none';
    const requestedVoxelResolution = options?.voxelResolution ?? 0.05;
    const opacityCutoff = options?.opacityCutoff ?? 0.1;
    const backend = options?.backend ?? 'gpu';
    const collisionMesh = options?.collisionMesh ?? false;
    const floorFill = options?.floorFill ?? false;
    const floorFillDilation = options?.floorFillDilation ?? 0;
    const cpuWorkerCount = options?.cpuWorkerCount ?? -1;
    const baseBox = options?.box ?? DEFAULT_VOXEL_BOX;
    const box = resolveVoxelBox(data, baseBox, options?.autoDenseBox ?? true);
    const nodeEncoding = options?.nodeEncoding ?? 'raw';
    const filterClusterOptions = options?.filterCluster ?? true;
    let sourceData = data;
    if (filterClusterOptions) {
        const filterOptions = filterClusterOptions === true ? {} : filterClusterOptions;
        const filterRuntime: FilterClusterRuntimeOptions = {
            backend,
            box,
        };
        if (options?.cpuWorkerCount !== undefined) {
            filterRuntime.cpuWorkerCount = cpuWorkerCount;
        }
        logger.info('voxel filterCluster enabled');
        sourceData = await filterCluster(data, filterOptions, filterRuntime);
    }
    let attemptVoxelResolution = requestedVoxelResolution;
    let result: VoxelWriteResult | undefined;
    for (let attempt = 0; attempt <= MAX_RESOLUTION_FALLBACK_ATTEMPTS; attempt++) {
        try {
            result = await writeVoxels(
                sourceData,
                attemptVoxelResolution,
                opacityCutoff,
                backend,
                collisionMesh,
                options?.navExteriorRadius,
                floorFill,
                floorFillDilation,
                cpuWorkerCount,
                box,
                options?.navCapsule,
                options?.navSeed,
                nodeEncoding,
                compression,
                requestedVoxelResolution,
            );
            break;
        } catch (error) {
            if (!(error instanceof SparseOctree24BitOverflowError) || attempt >= MAX_RESOLUTION_FALLBACK_ATTEMPTS) {
                throw error;
            }
            const failedResolution = error.voxelResolution ?? attemptVoxelResolution;
            const target = Math.min(OCTREE_24BIT_FALLBACK_TARGET, Math.floor(error.limit * 0.98));
            const nextVoxelResolution = chooseFallbackResolution(failedResolution, error.actual, target);
            const detail = `octree 24-bit ${error.kind} count=${error.actual}, target=${target}, limit=${error.limit}`;
            logger.info(
                `voxel resolution fallback: ${detail}; ` + `resolution ${failedResolution} -> ${nextVoxelResolution}`,
            );
            attemptVoxelResolution = nextVoxelResolution;
        }
    }
    if (!result) {
        throw new Error('voxel resolution fallback exhausted without producing output');
    }
    const { metadata, binary, collisionGlb } = result;
    fs.mkdirSync(outputDir, { recursive: true });
    const metaPath = path.join(outputDir, 'voxel-meta.json');
    const rawBytes = binary.length;
    const compressedBinary = compressVoxelBinary(binary, compression);
    const binPayload = compressedBinary.payload;
    const binPath = path.join(outputDir, compressedBinary.filename);
    metadata.files = [compressedBinary.filename];
    logger.info(`writing '${metaPath}'...`);
    fs.writeFileSync(metaPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
    logger.info(`writing '${binPath}'...`);
    fs.writeFileSync(binPath, binPayload);
    if (collisionGlb && collisionGlb.length > 0) {
        const glbPath = path.join(outputDir, 'collision.glb');
        logger.info(`writing '${glbPath}'...`);
        fs.writeFileSync(glbPath, collisionGlb);
    }
    function formatSize(bytes: number) {
        if (bytes >= 1024 * 1024) {
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    const octreeSizeMsg =
        compression === 'none'
            ? `octree ${formatSize(rawBytes)}`
            : `octree raw: ${formatSize(rawBytes)}, ${compression}: ${formatSize(binPayload.length)} (${formatCompressedSizePercent(rawBytes, binPayload.length)}%)`;
    if (collisionGlb && collisionGlb.length > 0) {
        logger.info(`${octreeSizeMsg}, collision mesh ${formatSize(collisionGlb.length)}`);
    } else {
        logger.info(octreeSizeMsg);
    }
}

export const voxelUtils = {
    getChildOffset,
    encodeMorton3,
    decodeMorton3,
};
