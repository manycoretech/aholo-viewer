---
title: Physics Collision
description: Generate voxel or mesh colliders from 3DGS scenes and run ray and capsule collision queries at runtime.
order: 6
---

## Background

A reconstructed 3DGS scene is a Gaussian point cloud without solid boundaries for walking or collision. The physics collision module turns that space into **queryable collision data**. Voxels or meshes describe floors, walls, occluders, and walkable regions for walk mode, camera avoidance, area limits, and spatial interaction.

Voxel colliders are produced from 3DGS assets by the `Voxel` task in `splat-transform`. The sections below describe the file format and runtime queries. An optional `collision.glb` mesh may also be provided.

## Overview

Voxel data encodes scene occupancy as a **sparse voxel octree (SVO)** for runtime collision and ray tests:

- **Raycast**: picking, grounding, line-of-sight checks
- **Sphere / capsule**: character depenetration

Encoding follows the **Laine–Karras** layout shared with [playcanvas/splat-transform](https://github.com/playcanvas/splat-transform) and [playcanvas/supersplat-viewer](https://github.com/playcanvas/supersplat-viewer).

## Sparse Octree Structure

The octree subdivides a uniform voxel grid and stores only non-empty regions to compress large scenes.

**Levels**

- `treeDepth` levels from root to leaf; the finest voxels have edge length `voxelResolution`.
- Each leaf covers a **4×4×4** block (`leafSize = 4`), i.e. 64 occupancy bits.

**Node types** (each `uint32` in `nodes`)

| Type              | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Interior node** | High 8 bits: `childMask` (which octants exist); low 24 bits: index of the first child; sibling indices use popcount. |
| **Solid leaf**    | Value `0xFF000000` (`SOLID_LEAF_MARKER`): the entire 4×4×4 block is solid.                                           |
| **Mixed leaf**    | `childMask == 0`; low 24 bits point to a 64-bit mask in `leafData` for per-voxel occupancy.                          |

**`leafData`**

- Each mixed leaf uses 2 `uint32` values (`lo`, `hi`), 64 bits total.
- Bit index for `(vx, vy, vz)` in the block: `vx + vy * 4 + vz * 16` (each ∈ [0, 3]).

**Traversal**

`nodes` use a compact breadth-first layout; only children in `childMask` are stored. Queries follow **one path** from the root for `treeDepth` levels.

**Occupancy at one voxel**: world position → `(ix, iy, iz)` → block `(⌊ix/4⌋, …)`. Descend from `nodes[0]`:

- **Solid leaf**: occupied.
- **Mixed leaf**: test `(ix&3, iy&3, iz&3)` against `leafData`.
- **Interior node**: pick the octant from block coordinates; if missing, empty; else next index is `baseOffset` plus popcount.

**Ray marching**: **3D DDA** steps through voxels inside the grid bounds; each cell repeats the occupancy query above.

**Output files**

- `voxel-meta.json`: grid bounds, voxel size, `treeDepth`, `nodeCount`, `leafDataCount`, etc.
- `voxel.bin`: binary blob with `nodes` then `leafData` (both as `uint32` arrays).
- Optional `collision.glb` mesh.

## Raycast & Collision Queries

`splat-transform` only **generates** voxel data. Ray tests and depenetration are implemented at **runtime** after loading the octree.

**Raycast**

1. Clip the ray to the grid bounds;
2. **3D DDA**: step to the next voxel face with the smallest parameter `t` along X/Y/Z;
3. For each cell, descend the octree and test occupancy;
4. Return the first solid hit; a miss if the ray exits the bounds.

Ray direction need not be normalized. Used for grounding, picking, and short obstacle checks.

**Position occupancy**

Map a world position to voxel indices and query whether it lies inside geometry, using the procedure above.

**Sphere / capsule**

For solid voxels in the bounding volume, measure distance from each cell to the sphere center or capsule axis. If less than the radius, accumulate push-out along the shortest separation. Iterate when resolving multi-contact.

## Acknowledgements

The voxel pipeline, octree encoding, and file format primarily reference PlayCanvas open-source projects:

| Project                          | URL                                             | Role                                                                                                                    |
| -------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **playcanvas/splat-transform**   | https://github.com/playcanvas/splat-transform   | Voxelization, nav fill/carve, octree export, collision mesh generation                                                  |
| **playcanvas/supersplat-viewer** | https://github.com/playcanvas/supersplat-viewer | Runtime voxel collision (raycast, sphere/capsule); see [Issues](https://github.com/playcanvas/supersplat-viewer/issues) |
