import type { Mesh } from './marching-cubes.js';
/**
 * Losslessly reduce coplanar regions of a marching-cubes mesh by
 * topology-preserving vertex removal.
 *
 * For a closed manifold MC mesh, a vertex `v` is "lossless-removable" iff
 * its incident-tri fan, walked in cyclic order, falls into one of:
 *
 * 1. K=1 coplanar fan. Every triangle in v's fan lies on the same plane
 * (same unit normal and same plane offset, within tolerance). Removing
 * v is the inverse of vertex split: re-triangulate the boundary
 * polygon in the same plane.
 *
 * 2. K=2 collinear seam. The fan splits into exactly two contiguous
 * coplanar arcs (different planes). The two crease vertices `a` and
 * `b` (the boundary points where the plane changes around v) are
 * collinear with v in 3D, with v between them. Removing v collapses
 * the two crease edges (v-a, v-b) into a single straight edge (a-b)
 * that lies in both planes; each arc's polygon re-triangulates
 * without v.
 *
 * Vertices with K >= 3 (multi-way corners) are kept.
 *
 * Removing a removable v is exact-lossless: the surface footprint is
 * identical, no vertex moves and none are created. The transformation
 * is the inverse of vertex split, so it is topology-preserving by
 * construction:
 *
 * - No T-junctions. Every old vertex on the polygon boundary remains a
 * vertex of every triangle that previously touched it. Adjacent fused
 * regions and verbatim regions stay coupled at every shared vertex.
 * - Watertight. The closed manifold structure is preserved across
 * removal. Both the K=1 and K=2 cases preserve the K=2 seam edge as
 * a single shared edge between the two plane groups.
 * - Bit-exact. Every output position is a verbatim copy of an input
 * position; no vertex is fabricated.
 *
 * Algorithm:
 *
 * 1. Build per-vertex incident-tri lists and per-tri normalized normals
 * and plane offsets.
 * 2. Process vertices via a dirty-flag worklist. Initially queue every
 * vertex; after a successful removal, re-queue the ring neighbours
 * so chains of K=1 / K=2 vertices collapse in one run.
 * 3. For each dequeued vertex `v`:
 * a. Walk the fan to extract the cyclic ring vertices and the
 * cyclic ordered tris (each tri (v, ring[i], ring[(i+1)%k]) is
 * the i-th tri in fan order).
 * b. Decide K. If all tris share a plane: K=1. Otherwise count
 * transitions in cyclic order; K=2 if exactly two arcs.
 * c. K>=3: skip. K=2: verify ring[i1], v, ring[i2] are collinear.
 * d. For each arc, project its polygon to 2D using the arc's
 * plane basis, ear-clip, and append the new tris.
 * e. Mark v's old tris dead, register the new tris in each polygon
 * vertex's incident list, and re-queue the ring.
 * 4. Compact: drop dead tris and unused vertices, remap indices.
 *
 * @param mesh - Input triangle mesh from {@link marchingCubes}.
 * @param voxelResolution - Size of one voxel in world units. Used to scale the plane-offset tolerance. (The K=2 collinearity check is purely angular and has no voxel-scaled term.)
 * @returns A new mesh with the same surface geometry, no T-junctions, and far fewer triangles.
 */
declare const coplanarMerge: (mesh: Mesh, voxelResolution: number) => Mesh;
export { coplanarMerge };
