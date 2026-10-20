---
title: Chunk LOD
description: Chunk LOD data format, scheduler configuration, and runtime integration.
order: 8
---

## Background

Rendering large-scale `3DGS` scenes requires far more system resources than most current devices provide. Large `3DGS` scenes are therefore difficult to render directly on common hardware. A `stream + LOD` approach reduces resource requirements by sacrificing detail in less important regions and preserving quality near the visual focus. `@manycore/aholo-viewer` uses a chunked LOD implementation, `chunk-lod`, as its primary LOD solution. LOD data is generated through a post-processing Gaussian fusion pipeline that does not require retraining.

![chunk-lod](../assets/chunk-lod/structure.png)

## Generating `chunk-lod`

`chunk-lod` data used by `@manycore/aholo-viewer` is usually generated with [`@manycore/aholo-splat-transform`](./splat-transform.md). ESZ output is recommended. Generation mainly includes these steps:

1. Chunk splitting
    > Chunks are split primarily with an octree. `maxChunkCounts` defaults to `400000` Gaussians to control initial block size. Increase it for large scenes to reduce the block count; merged level files can exceed that size.
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
    > The default `5%` and `1%` coarse levels set `merged: true` and `permanent: true`, combining blocks not already assigned to output files and marking referenced files for residency. A custom `levels` array replaces all defaults; omitting either flag means `false`. The final `lod-meta.json` describes file intervals for each block. See [AutoChunkLod](./splat-transform.md#autochunklod) for complete parameters.

References:

- [A Hierarchical 3D Gaussian Representation for Real-Time Rendering of Very Large Datasets](https://repo-sam.inria.fr/fungraph/hierarchical-3d-gaussians/)
- [NanoGS: Training-Free Gaussian Splat Simplification](https://saliteta.github.io/NanoGS/)

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
    voxels?: string[];
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
- `voxels`: optional voxel metadata paths relative to the directory containing this `lod-meta.json`, for example `["../voxel/voxel-meta.json"]`. The pipeline adds successful voxel outputs associated with the same input or a simplified or extracted model derived from it. Multiple outputs are supported and duplicate paths are removed. `Voxel` may run before or after the LOD `Write`; the field is omitted when no associated voxel output exists.
- `permanentFiles`: file indices that must stay resident in memory or GPU memory.
- `tree`: chunk tree for `lod`.
    - `tree[i].bound`: chunk bounding box. This box is also computed from an approximate distribution and excludes outliers.
    - `tree[i].lods`: LOD data for the chunk.
        - `tree[i].lods[j].file`: data file index.
        - `tree[i].lods[j].offset`: starting Gaussian offset.
        - `tree[i].lods[j].count`: Gaussian count.

## `LodSplat` Scheduler

`@manycore/aholo-viewer` provides streaming scheduling through [`SplatUtils.LodSplat`](api:SplatUtils.LodSplat). See [Splatting LOD Stream](../../examples/splatting-lod-stream/) for a complete example.

The scheduler establishes coarse coverage for visible chunks, then allocates detail according to projected screen area, position relative to the screen center, and the remaining point budget. `Level 0` is the finest level; larger values represent coarser levels. Camera motion limits new refinement, and refinement resumes after the view settles. Already displayed fine detail is not downgraded solely because of the motion limit.

### Configuration

The second constructor argument and `setConfig()` both accept `Partial<SplatUtils.LodConfig>`. The table lists SDK defaults. The streaming example sets `maxBudget` to `6_000_000` and displays it in millions of points.

| Parameter                    | Default     | Description                                                                                                                                               |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minLevel`                   | `0`         | Finest level the scheduler may select.                                                                                                                    |
| `movingMinLevel`             | `2`         | Finest level allowed for new refinement while the camera moves. The effective limit is `max(minLevel, movingMinLevel)`.                                   |
| `maxBudget`                  | `3_000_000` | Target Gaussian point budget for LOD selection.                                                                                                           |
| `hysteresisTicks`            | `4`         | Stability delay for a target level. Each tick is fixed at `1000 / 60` ms, so the default is about `66.7` ms, independent of how often `tick()` is called. |
| `schedulerParallelCounts`    | `4`         | Maximum number of concurrent LOD resource loads.                                                                                                          |
| `schedulerExistingTaskLimit` | `64`        | Limits scene updates per batch and pauses detail requests when enough prepared work is waiting.                                                           |
| `schedulerMinDuration`       | `160`       | Minimum interval between scheduling passes and ordinary commits, in ms. Cached coarse coverage can be restored immediately.                               |
| `mergeNodeEnabled`           | `true`      | Merges adjacent nodes that can share contiguous resource ranges to reduce the number of `Splat` objects.                                                  |
| `frustumCullingEnabled`      | `true`      | Unloads chunks outside the frustum. When disabled, those chunks retain coarse coverage.                                                                   |
| `debuggerEnabled`            | `false`     | Colors splats by their current LOD level.                                                                                                                 |

Level parameters are clamped to `0` through `meta.levels - 1`. `maxBudget` is an allocation target: if minimum coverage exceeds it, the scheduler prioritizes coverage. Resource caches and level transitions also consume additional system and GPU memory.

### Integration and Frame Loop

Inside an example's `RenderRuntime`, use the following pattern after loading `meta`. With the default resource loader, first resolve relative paths in `meta.files` against the `lod-meta.json` URL. A custom loader can also handle path resolution.

```typescript
import { createViewerContext, SplatUtils } from '@manycore/aholo-viewer';

const { viewer, scene } = renderer;
const lod = new SplatUtils.LodSplat(
    meta,
    { minLevel: 0, movingMinLevel: 2, maxBudget: 6_000_000 },
    createViewerContext(viewer),
);
scene.add(lod.container);
lod.tick(viewer.getCamera());
lod.start();

renderer.frame(({ delta }) => {
    const updated = control.update(delta);
    lod.tick(viewer.getCamera());
    return updated;
});

return () => lod.destroy();
```

- `tick(camera, viewport?)` updates camera and viewport information. When a viewer context is supplied, it defaults to the viewer's drawing buffer size. You can also pass `{ width, height }` in render pixels. The viewport limits sampling density; without viewport information, only relative weights and the point budget apply.
- `start()` starts automatic scheduling. If the application owns the frame loop, call `tick()` followed by `flush()` each frame without starting the automatic loop. `stop()` only stops automatic scheduling and retains displayed and prepared resources.
- `onFinishSchedule()` waits for the current schedule to converge. Call `tick()` at least once beforehand, keep automatic scheduling or `flush()` running while waiting, and continue rendering so sorting can complete. The Promise rejects on resource loading or replacement failures; release the instance on error.
- The optional fourth constructor argument is a resource loader with the signature `(url, signal?) => Promise<SplatLoader.SplatData>`. Forward `signal` to `fetch()` to handle cancellation of obsolete requests or instance destruction. Custom caches should check cancellation after asynchronous reads and parsing.
- Call `destroy()` when leaving the page or replacing the scene to stop scheduling, cancel requests, and release LOD resources.

### Voxel Occlusion Downgrading

Use `meta.voxels` together with the fifth constructor argument, `parseVoxel`, to enable voxel occlusion downgrading. Metadata paths alone do not trigger voxel loading. The callback resolves relative paths, loads metadata and binary data, and responds to the supplied `AbortSignal`.

The callback returns `gridBounds`, `voxelResolution`, `leafSize`, `treeDepth`, `nodeCount`, `leafDataCount`, and `buffer: Uint32Array`. The buffer contains node words followed by leaf bitmap words. `leafSize` must be `4`, and coordinates must match the LOD container's local space. See [Physics Collision](./physics-collision.md) for the file format.

Occluded chunks retain a coarser level to reduce detail loading. Missing voxel data, loading failures, or query errors leave ordinary LOD allocation active.

### Migrating Existing Configuration

- Remove `backgroundPenalty` and `distanceStep`. The scheduler no longer uses background weights or distance bands. Control detail with `minLevel`, `movingMinLevel`, `maxBudget`, and the viewport size.
- The older `outsidePenalty`, `behindPenalty`, `behindTolerance`, `behindDistanceTolerance`, and `debuggerType` fields have also been removed. Use `frustumCullingEnabled` to control unloading outside the frustum and `debuggerEnabled` for LOD debug colors.
- `hysteresisTicks` uses fixed 60 Hz time units instead of counting calls to `tick()`. Changing the call frequency does not change the stability delay.
