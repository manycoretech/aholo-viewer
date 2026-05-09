import { SparseVoxelGrid, type Bounds } from './common.js';
/**
 * A simple triangle mesh with positions and indices.
 */
interface Mesh {
    /** Vertex positions (3 floats per vertex) */
    positions: Float32Array;
    /** Triangle indices (3 indices per triangle) */
    indices: Uint32Array;
}
/**
 * Result of marching cubes surface extraction.
 */
type MarchingCubesMesh = Mesh;
/**
 * Options for marching cubes extraction.
 */
interface MarchingCubesOptions {
    /**
     * Pre-merge exact full-face cells on flat axis-aligned regions before
     * creating the mesh. Ambiguous and bevel cases still use normal marching
     * cubes, so coplanarMerge can apply the final lossless optimization.
     */
    mergeFlatFaces?: boolean;
}
/**
 * Extract a triangle mesh from a SparseVoxelGrid using marching cubes.
 *
 * Each voxel is treated as a cell in the marching cubes grid. Corner values
 * are binary (0 = empty, 1 = occupied) with a 0.5 threshold. Vertices are
 * placed at edge midpoints, producing the binary-field isosurface between
 * occupied and empty samples.
 *
 * @param grid - Voxel grid (after filtering / nav phases)
 * @param gridBounds - Grid bounds aligned to block boundaries
 * @param voxelResolution - Size of each voxel in world units
 * @param options - Optional extraction settings
 * @returns Mesh with positions and indices
 */
declare function marchingCubes(grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number, options?: MarchingCubesOptions): MarchingCubesMesh;
export { marchingCubes };
export type { Mesh, MarchingCubesMesh, MarchingCubesOptions };
