import { BlockMaskBuffer, SparseVoxelGrid, type Bounds } from './common.js';
/**
 * Block cleanup pass:
 * - remove voxels that have no supporting 6-neighborhood occupancy
 * - fill single-voxel holes fully enclosed by 6 neighbors
 * Includes cross-block neighbor propagation for face-adjacent blocks.
 */
export declare const filterAndFillBlocks: (blocks: BlockMaskBuffer, nbx?: number, nby?: number, nbz?: number) => BlockMaskBuffer;
export type { Bounds } from './common.js';
/** Crop blocks into [min, max) block range and rebase linear block coordinates. */
export declare const cropBlocksToRange: (blocks: BlockMaskBuffer, sourceNbx: number, sourceNby: number, cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number) => BlockMaskBuffer;
/** Compute world-space bounds corresponding to a cropped block range. */
export declare const cropBounds: (gridBounds: Bounds, voxelResolution: number, cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number) => Bounds;
/** Tight crop to occupied block bounds. */
export declare const cropToOccupied: (grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number) => {
    grid: SparseVoxelGrid;
    gridBounds: Bounds;
};
/** Tight crop to navigable (non-fully-solid) block bounds. */
export declare const cropToNavigable: (grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number) => {
    grid: SparseVoxelGrid;
    gridBounds: Bounds;
};
