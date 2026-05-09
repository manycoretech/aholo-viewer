import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { logger, cpuVoxelize, gpuVoxelize } from '../utils/index.js';
import { fillExterior, fillFloor, carve } from '../utils/voxel/nav.js';
import { buildCollisionMesh } from '../utils/voxel/mesh.js';
import { cropToNavigable, cropToOccupied, filterAndFillBlocks } from '../utils/voxel/postprocess.js';
import { alignGridBounds, ALPHA_THRESHOLD, BlockMaskBuffer, buildSparseOctree, decodeMorton3, encodeMorton3, extentsFromQuatScale, getChildOffset, SparseVoxelGrid } from '../utils/voxel/common.js';
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
const writeVoxels = async (data, voxelResolution = 0.05, opacityCutoff = 0.1, backend = 'gpu', collisionMesh = false, navExteriorRadius, floorFill = false, floorFillDilation = 0, cpuWorkerCount = -1, box = { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] }, navCapsule, navSeed) => {
    const hasNav = !!(navCapsule && navSeed && navCapsule.height > 0);
    const hasFillExterior = !!(navExteriorRadius && navSeed);
    const hasFloorFill = floorFill;
    logger.info(`voxel params: resolution=${voxelResolution}, opacityCutoff=${opacityCutoff}, backend=${backend}, ` +
        `collisionMesh=${collisionMesh}, navExteriorRadius=${navExteriorRadius ?? 'none'}, ` +
        `floorFill=${floorFill}, floorFillDilation=${floorFillDilation}, cpuWorkerCount=${cpuWorkerCount === -1 ? 'auto' : cpuWorkerCount}, ` +
        `box=${JSON.stringify(box)}, navCapsule=${navCapsule ? JSON.stringify(navCapsule) : 'none'}, ` +
        `navSeed=${navSeed ? JSON.stringify(navSeed) : 'none'}, hasFillExterior=${hasFillExterior}, hasFloorFill=${hasFloorFill}, hasNav=${hasNav}`);
    const xCol = data.table[0 /* ColIdx.x */];
    const yCol = data.table[1 /* ColIdx.y */];
    const zCol = data.table[2 /* ColIdx.z */];
    const sxCol = data.table[3 /* ColIdx.sx */];
    const syCol = data.table[4 /* ColIdx.sy */];
    const szCol = data.table[5 /* ColIdx.sz */];
    const qxCol = data.table[6 /* ColIdx.qx */];
    const qyCol = data.table[7 /* ColIdx.qy */];
    const qzCol = data.table[8 /* ColIdx.qz */];
    const qwCol = data.table[9 /* ColIdx.qw */];
    const aCol = data.table[13 /* ColIdx.a */];
    const sceneBounds = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    // Compute per-gaussian AABB extents from quaternion+scale and accumulate scene bounds.
    logger.time('Voxel bounding/extents');
    const extents = new Float32Array(data.counts * 3);
    const extentOpacityThreshold = ALPHA_THRESHOLD;
    let invalidExtentCount = 0;
    for (let i = 0; i < data.counts; i++) {
        const e = extentsFromQuatScale(sxCol[i], syCol[i], szCol[i], qxCol[i], qyCol[i], qzCol[i], qwCol[i], aCol[i], extentOpacityThreshold);
        if (!Number.isFinite(e.ex) || !Number.isFinite(e.ey) || !Number.isFinite(e.ez)) {
            extents[i * 3 + 0] = 0;
            extents[i * 3 + 1] = 0;
            extents[i * 3 + 2] = 0;
            invalidExtentCount++;
        }
        else {
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
    logger.info(`scene extents: (${sceneBounds.min.x.toFixed(2)},${sceneBounds.min.y.toFixed(2)},${sceneBounds.min.z.toFixed(2)}) - (${sceneBounds.max.x.toFixed(2)},${sceneBounds.max.y.toFixed(2)},${sceneBounds.max.z.toFixed(2)})`);
    logger.timeEnd('Voxel bounding/extents');
    const exteriorPad = hasFillExterior
        ? (Math.ceil(navExteriorRadius / voxelResolution) + 1) * voxelResolution
        : 0;
    const floorPad = hasFloorFill
        ? (Math.ceil(floorFillDilation / voxelResolution) + 1) * voxelResolution
        : 0;
    const padXZ = Math.max(exteriorPad, floorPad);
    const padY = exteriorPad;
    const rawVoxelBounds = {
        min: {
            x: sceneBounds.min.x - padXZ,
            y: sceneBounds.min.y - padY,
            z: sceneBounds.min.z - padXZ
        },
        max: {
            x: sceneBounds.max.x + padXZ,
            y: sceneBounds.max.y + padY,
            z: sceneBounds.max.z + padXZ
        }
    };
    const voxelBounds = {
        min: {
            x: Math.max(rawVoxelBounds.min.x, box.minCorner[0]),
            y: Math.max(rawVoxelBounds.min.y, box.minCorner[1]),
            z: Math.max(rawVoxelBounds.min.z, box.minCorner[2])
        },
        max: {
            x: Math.min(rawVoxelBounds.max.x, box.maxCorner[0]),
            y: Math.min(rawVoxelBounds.max.y, box.maxCorner[1]),
            z: Math.min(rawVoxelBounds.max.z, box.maxCorner[2])
        }
    };
    const boxCropApplied = voxelBounds.min.x > rawVoxelBounds.min.x ||
        voxelBounds.min.y > rawVoxelBounds.min.y ||
        voxelBounds.min.z > rawVoxelBounds.min.z ||
        voxelBounds.max.x < rawVoxelBounds.max.x ||
        voxelBounds.max.y < rawVoxelBounds.max.y ||
        voxelBounds.max.z < rawVoxelBounds.max.z;
    if (boxCropApplied) {
        logger.info(`voxel box crop applied: ` +
            `raw=(${rawVoxelBounds.min.x.toFixed(2)},${rawVoxelBounds.min.y.toFixed(2)},${rawVoxelBounds.min.z.toFixed(2)})-` +
            `(${rawVoxelBounds.max.x.toFixed(2)},${rawVoxelBounds.max.y.toFixed(2)},${rawVoxelBounds.max.z.toFixed(2)}), ` +
            `cropped=(${voxelBounds.min.x.toFixed(2)},${voxelBounds.min.y.toFixed(2)},${voxelBounds.min.z.toFixed(2)})-` +
            `(${voxelBounds.max.x.toFixed(2)},${voxelBounds.max.y.toFixed(2)},${voxelBounds.max.z.toFixed(2)})`);
    }
    if (voxelBounds.min.x >= voxelBounds.max.x || voxelBounds.min.y >= voxelBounds.max.y || voxelBounds.min.z >= voxelBounds.max.z) {
        throw new Error(`voxel box does not overlap scene bounds: box=${JSON.stringify(box)}`);
    }
    // Align to 4x4x4 block grid.
    const gridBounds = alignGridBounds(voxelBounds, voxelResolution);
    let blocks = new BlockMaskBuffer();
    if (backend === 'gpu') {
        const gpuStart = Date.now();
        try {
            blocks = await gpuVoxelize(xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff);
            const gpuElapsed = Date.now() - gpuStart;
            logger.info(`Voxelizing (GPU) done: ${(gpuElapsed / 1000).toFixed(3)}s`);
        }
        catch (e) {
            const gpuElapsed = Date.now() - gpuStart;
            logger.error('Voxel GPU backend failed, fallback to CPU.');
            logger.error(`Voxelizing (GPU) failed after ${(gpuElapsed / 1000).toFixed(3)}s`);
            if (e instanceof Error) {
                logger.error(`GPU error message: ${e.message}`);
                if (e.stack) {
                    logger.error(`GPU error stack: ${e.stack}`);
                }
            }
            else {
                logger.error(`GPU error: ${String(e)}`);
            }
        }
    }
    if (backend === 'cpu' || blocks.count === 0) {
        logger.time('Voxelizing (CPU)');
        blocks = await cpuVoxelize(xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff, { workerCount: cpuWorkerCount });
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
        const fillResult = await fillExterior(grid, navGridBounds, voxelResolution, navExteriorRadius, navSeed, backend);
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
        const navResult = await carve(grid, navGridBounds, voxelResolution, navCapsule.height, navCapsule.radius, navSeed, backend);
        grid = navResult.grid;
        navGridBounds = navResult.gridBounds;
        logger.timeEnd('Carve nav');
    }
    // Crop padded bounds before octree build.
    // If navigability passes ran, keep navigable extent; otherwise crop to occupied extent.
    logger.time('Crop voxel bounds');
    const finalCrop = (hasFillExterior || hasFloorFill)
        ? cropToNavigable(grid, navGridBounds, voxelResolution)
        : cropToOccupied(grid, navGridBounds, voxelResolution);
    grid = finalCrop.grid;
    navGridBounds = finalCrop.gridBounds;
    logger.timeEnd('Crop voxel bounds');
    const collisionMeshShape = (() => {
        if (collisionMesh === false || collisionMesh === undefined) {
            return null;
        }
        if (collisionMesh === true) {
            return 'smooth';
        }
        if (collisionMesh === 'smooth' || collisionMesh === 'faces') {
            return collisionMesh;
        }
        throw new Error(`Invalid collisionMesh value: ${String(collisionMesh)}. Expected true, false, "smooth", or "faces"`);
    })();
    const collisionGlb = collisionMeshShape
        ? buildCollisionMesh(grid, navGridBounds, voxelResolution, collisionMeshShape)
        : undefined;
    // BuildSparseOctree emits Laine-Karras nodes + mixed leaf masks.
    logger.time('Build octree');
    const octree = buildSparseOctree(grid, navGridBounds, sceneBounds, voxelResolution, { consumeGrid: true });
    logger.timeEnd('Build octree');
    logger.info(`octree: depth=${octree.treeDepth}, interior=${octree.numInteriorNodes}, mixed=${octree.numMixedLeaves}`);
    const metadata = {
        version: '1.1',
        gridBounds: {
            min: [octree.gridBounds.min.x, octree.gridBounds.min.y, octree.gridBounds.min.z],
            max: [octree.gridBounds.max.x, octree.gridBounds.max.y, octree.gridBounds.max.z]
        },
        sceneBounds: {
            min: [octree.sceneBounds.min.x, octree.sceneBounds.min.y, octree.sceneBounds.min.z],
            max: [octree.sceneBounds.max.x, octree.sceneBounds.max.y, octree.sceneBounds.max.z]
        },
        voxelResolution: octree.voxelResolution,
        leafSize: octree.leafSize,
        treeDepth: octree.treeDepth,
        numInteriorNodes: octree.numInteriorNodes,
        numMixedLeaves: octree.numMixedLeaves,
        nodeCount: octree.nodes.length,
        leafDataCount: octree.leafData.length,
        files: ['voxel.bin']
    };
    const binarySize = (octree.nodes.length + octree.leafData.length) * 4;
    const binary = new Uint8Array(binarySize);
    const view = new Uint32Array(binary.buffer);
    view.set(octree.nodes, 0);
    view.set(octree.leafData, octree.nodes.length);
    return { metadata, binary, collisionGlb };
};
export async function writeVoxelFiles(outputDir, data, options) {
    const { metadata, binary, collisionGlb } = await writeVoxels(data, options?.voxelResolution ?? 0.05, options?.opacityCutoff ?? 0.1, options?.backend ?? 'gpu', options?.collisionMesh ?? false, options?.navExteriorRadius, options?.floorFill ?? false, options?.floorFillDilation ?? 0, options?.cpuWorkerCount ?? -1, options?.box ?? { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] }, options?.navCapsule, options?.navSeed);
    fs.mkdirSync(outputDir, { recursive: true });
    const metaPath = path.join(outputDir, 'voxel-meta.json');
    const binPath = path.join(outputDir, 'voxel.bin');
    logger.info(`writing '${metaPath}'...`);
    fs.writeFileSync(metaPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
    logger.info(`writing '${binPath}'...`);
    fs.writeFileSync(binPath, binary);
    if (collisionGlb && collisionGlb.length > 0) {
        const glbPath = path.join(outputDir, 'collision.glb');
        logger.info(`writing '${glbPath}'...`);
        fs.writeFileSync(glbPath, collisionGlb);
    }
    const totalBytes = binary.length;
    if (collisionGlb && collisionGlb.length > 0) {
        logger.info(`total size: octree ${(totalBytes / 1024).toFixed(1)} KB, collision mesh ${(collisionGlb.length / 1024).toFixed(1)} KB`);
    }
    else {
        logger.info(`total size: ${(totalBytes / 1024).toFixed(1)} KB`);
    }
}
export const voxelUtils = {
    getChildOffset,
    encodeMorton3,
    decodeMorton3
};
