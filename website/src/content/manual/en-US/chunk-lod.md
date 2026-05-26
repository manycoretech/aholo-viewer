---
title: Chunk LOD
description: Chunk LOD reference.
order: 8
---

## Background

Rendering large-scale `3DGS` scenes requires far more system resources than most current devices provide. Large `3DGS` scenes are therefore difficult to render directly on common hardware. A `stream + LOD` approach reduces resource requirements by sacrificing detail in less important regions and preserving quality near the visual focus. `@manycore/aholo-viewer` uses a chunked LOD implementation, `chunk-lod`, as its primary LOD solution. LOD data is generated through a post-processing Gaussian fusion pipeline that does not require retraining.

![chunk-lod](../assets/chunk-lod/structure.png)

## Generating `chunk-lod`

`chunk-lod` data used by `@manycore/aholo-viewer` is usually generated with [`@manycore/aholo-splat-transform`](./splat-transform.md). The generation process mainly includes these steps:

1. Chunk splitting
    > Chunks are split primarily with an octree. The default maximum chunk size is `400000` Gaussians. For large scenes, increase it to `800000` or higher to control the final `chunk` count.
2. Gaussian search and fusion
    > Inside each chunk, each `lod` level is generated from the previous level. Every level repeatedly searches and merges Gaussians until it reaches the target count.
    >
    > For levels that retain fewer Gaussians, the remaining Gaussians are enlarged to reduce holes caused by low retained counts.
    >
    > After fusion, an additional `opacity` culling pass removes Gaussians with poor visibility.
    >
    > When the Gaussian count is below a threshold, fusion stops. This can make the output count slightly higher than the target, but the deviation is small and reducing the final number of chunks is usually worth it.
    >
    > To avoid non-terminating processing, each level has a maximum iteration count. If that limit is reached, processing exits even if the target count has not been met.
3. Output processing
    > Low-level data is packed together during output. Low-level data is usually about `1%` of the original data, so the amount is small and packing also removes unnecessary chunks. The final output includes `lod-meta.json`, which describes the `chunk-lod` data.

References:

- [gaussian-hierarchy](https://github.com/graphdeco-inria/gaussian-hierarchy/tree/main)
- [NanoGS](https://github.com/saliteta/NanoGS)

## `lod-meta.json` Format

```typescript
interface IBox {
    min: [number, number, number];
    max: [number, number, number];
}

// typings for
interface LodMeta {
    magicCode: 2500660;
    type: 'lod-splat';
    version: string;
    counts: number;
    shDegree: number;
    levels: number;
    files: string[];
    forwardBox: IBox;
    permanentFiles: number[];
    tree: Array<{
        bound: IBox;
        lods: Array<{
            file: number;
            offset: number;
            count: number;
        }>;
    }>;
}
```

- `counts`: total Gaussian count at `level 0`.
- `shDegree`: spherical harmonics degree.
- `forwardBox`: bounding box of the space containing roughly `80%` of all Gaussian spheres at `level 0`.
- `files`: file list.
- `permanentFiles`: file indices that must stay resident in memory or GPU memory.
- `tree`: chunk tree for `lod`.
    - `tree[i].bound`: chunk bounding box. This box is also computed from an approximate distribution and excludes outliers.
    - `tree[i].lods`: LOD data for the chunk.
        - `tree[i].lods[j].file`: data file index.
        - `tree[i].lods[j].start`: starting Gaussian offset.
        - `tree[i].lods[j].count`: Gaussian count.

## `Lod` Scheduler

`@manycore/aholo-viewer` provides a complete `chunk-lod` scheduler. See [`LodSplat`](api:SplatUtils.LodSplat) for the API reference and [Streaming LOD](../../examples/splatting-lod-stream/) for an example.
