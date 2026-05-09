import type { Bounds } from './common.js';
import type { Mesh } from './marching-cubes.js';
import { SparseVoxelGrid } from './common.js';
/**
 * Extract a watertight voxel-boundary mesh from a SparseVoxelGrid.
 *
 * Exposed voxel faces are first greedily merged into axis-aligned rectangles.
 * Rectangle boundaries are then split at every collinear rectangle corner
 * before triangulation, so adjacent rectangles share matching edges instead
 * of producing T-junctions.
 *
 * @param grid - Voxel grid after filtering / nav phases.
 * @param gridBounds - Grid bounds aligned to block boundaries.
 * @param voxelResolution - Size of each voxel in world units.
 * @returns Mesh with positions and indices.
 */
declare const voxelFaces: (grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number) => Mesh;
export { voxelFaces };
