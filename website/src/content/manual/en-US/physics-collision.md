---
title: Physics Collision
description: Generate voxel or mesh colliders from 3DGS scenes and run ray and capsule collision queries at runtime.
order: 6
---

## Background

A reconstructed 3DGS scene is a Gaussian point cloud without solid boundaries for walking or collision. The physics collision module turns that space into **queryable collision data**. Voxels or meshes describe floors, walls, occluders, and walkable regions for walk mode, camera avoidance, area limits, and spatial interaction.

Voxel colliders are produced from 3DGS assets by the `Voxel` task in `splat-transform`. See the [Voxel task](./splat-transform.md#voxel) for generation parameters, CPU/GPU selection, and fallback rules. Set `collisionMesh: "smooth"` or `"faces"` to also generate a `collision.glb` mesh.

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

| Type              | Meaning                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Interior node** | High 8 bits: `childMask` (which octants exist); low 24 bits: index of the first child; sibling indices use popcount.                                   |
| **Solid node**    | Value `0xFF000000` (`SOLID_LEAF_MARKER`): the complete region covered by this node is solid; traversal can stop before reaching the finest leaf block. |
| **Mixed leaf**    | `childMask == 0`; the low 24 bits contain a 64-bit leaf-mask index `n`, addressing `leafData[2*n]` and `leafData[2*n+1]`.                              |

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

## Output Files and Encoding

Defaults are `nodeEncoding: "raw"` and `compression: "none"`. Encoding and compression are independent: compact node data can also use gzip or zstd compression.

| File              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `voxel-meta.json` | Metadata and the current binary filename.                             |
| `voxel.bin`       | `compression: "none"`.                                                |
| `voxel.bin.gz`    | `compression: "gzip"`.                                                |
| `voxel.bin.zst`   | `compression: "zstd"`.                                                |
| `collision.glb`   | Written when `collisionMesh` is enabled and produces a nonempty mesh. |

### Metadata

```typescript
interface VoxelMetadata {
    version: '1.2';
    gridBounds: { min: [number, number, number]; max: [number, number, number] };
    sceneBounds: { min: [number, number, number]; max: [number, number, number] };
    voxelResolution: number;
    leafSize: 4;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
    files: string[];
    nodeEncoding: 'raw' | 'compact';
    compression: 'none' | 'gzip' | 'zstd';
}
```

Paths in `files` are relative to the directory containing `voxel-meta.json`. `nodeCount` counts decoded uint32 nodes; `leafDataCount` counts uint32 leaf values and equals `numMixedLeaves * 2`. Generation can increase voxel edge length when grid or octree indices exceed capacity. Queries must use the effective `voxelResolution` and `gridBounds` from metadata.

### raw Encoding

After decompression, little-endian uint32 values are stored consecutively: `nodeCount` nodes followed by `leafDataCount` leaf values. The byte length must equal `4 * (nodeCount + leafDataCount)`. Each mixed-leaf mask stores its low 32 bits before its high 32 bits.

### compact Encoding

compact is a storage encoding and cannot be read directly as raw `nodes + leafData`. After decompression, it contains:

1. A 32-byte header with eight little-endian uint32 values: magic `0x31424356` (`VCB1`), encoding version `1`, node count, interior-node count, mixed-leaf count, leaf uint32 count, tag byte count, and child-mask byte count.
2. Two bits per node tag, least-significant bits first: `0` for mixed leaves, `1` for solid nodes, `2` for interior nodes, and reserved `3`. Tag storage uses `ceil(nodeCount / 4)` bytes.
3. One child-mask byte per interior node, in node order.
4. Zero padding to four-byte alignment, followed by little-endian uint32 leaf data.

Reconstruct raw nodes in breadth-first order: the first-child index starts at `1` and advances by `popcount(childMask)` for each interior node; mixed-leaf indices increase from `0`; solid nodes become `0xFF000000`. Validate the header, tags, counts, and file length during decoding.

### Loading Sequence

1. Read metadata and resolve `files[0]` relative to its URL.
2. Decompress according to `compression`. Do not decompress twice if HTTP `Content-Encoding` already handled it transparently.
3. Read raw data or decode compact data into raw nodes and leaf values according to `nodeEncoding`.
4. Pass the decoded arrays and metadata to runtime queries. Chunk LOD's `parseVoxel` expects a `Uint32Array` containing nodes followed by leaf data; see [Voxel Occlusion Downgrading](./chunk-lod.md#voxel-occlusion-downgrading).

Generation overwrites matching voxel files without clearing the directory. Switching compression or disabling mesh output can leave older files; use the current configuration and metadata to identify the output.

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
