import { SparseVoxelGrid, type Bounds } from './common.js';
interface NavSeed {
    x: number;
    y: number;
    z: number;
}
type VoxelBackend = 'cpu' | 'gpu';
interface VoxelNavResult {
    grid: SparseVoxelGrid;
    gridBounds: Bounds;
}
/**
 * Fill exterior-reachable space from boundary seeds and merge it back into
 * occupancy after dilation. Returns cropped bounds around navigable volume.
 */
export declare function fillExterior(gridOriginal: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number, dilation: number, seed: NavSeed, backend?: VoxelBackend): Promise<VoxelNavResult>;
/**
 * Carve navigable space for a capsule by:
 * 1) dilating blocked voxels by capsule dimensions
 * 2) flood filling reachable empty space from the seed
 * 3) dilating and inverting to final occupancy representation.
 */
export declare function carve(grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number, capsuleHeight: number, capsuleRadius: number, seed: NavSeed, backend?: VoxelBackend): Promise<VoxelNavResult>;
/**
 * Floor-fill via XZ dilate -> per-column upward walk -> XZ dilate -> OR.
 * This mirrors upstream's block/bitmask walk instead of per-voxel getVoxel checks.
 */
export declare function fillFloor(gridOriginal: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number, dilation?: number, backend?: VoxelBackend): Promise<VoxelNavResult>;
export type { NavSeed, Bounds };
