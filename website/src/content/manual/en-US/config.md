---
title: Aholo-Viewer Config
description: Reference for ViewerConfig, render modes, and post-processing options.
order: 3
---

## Overview

`ViewerConfig` controls the default rendering behavior of Aholo-Viewer.

## Configuration Path

```typescript
function setViewerConfig(ctx: Viewer | Viewport, config: IViewerConfig);
```

### [`PipelineConfig`](api:IPipelineConfig)

`pipeline` controls pipeline features. Toggle each section with its `enabled` option.

- [`Background`](api:IBackgroundPluginConfig): Controls background rendering, such as skyboxes and ground grids.
- [`Composite`](api:ICompositePluginConfig): Controls composition before output, usually to optimize multi-view rendering performance.
- [`Splatting`](api:ISplattingPluginConfig): Controls `3DGS` rendering behavior. For detailed parameter guidance, see [3dgs-preset-config](./3dgs-preset-config.md).
- [`TAA`](api:ITaaPluginConfig): Controls static temporal supersampling anti-aliasing.

[Full Parameter Reference](api:IViewerConfig)

## Splatting Sorting and Texture Repacking

Version 1.13 adds `pipeline.Splatting.sort.radial` and `pipeline.Splatting.pack.repackEnabled`. Both default to `false`.

```typescript
import { setViewerConfig } from '@manycore/aholo-viewer';

setViewerConfig(viewer, {
    pipeline: {
        Splatting: {
            enabled: true,
            sort: {
                radial: true,
                highPrecisionEnabled: true,
            },
            pack: {
                repackEnabled: true,
            },
        },
    },
});
```

| Parameter                   | Default | Description                                                                                                                                        |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sort.radial`               | `false` | Sorts Gaussian centers by distance from the camera instead of view-direction depth.                                                                |
| `sort.highPrecisionEnabled` | `false` | On WebGL, enables stable sorting on the upper 24 bits of float32 sort keys. When disabled, WebGL uses half-float sorting.                          |
| `pack.repackEnabled`        | `false` | Repacks WebGL rendering textures in sorted order to reduce indirect texture lookups during rasterization. Adds GPU memory usage and a repack pass. |

Radial distance and view-direction depth can produce different transparency blending orders; evaluate them with the target scene. Repacking performance depends on the scene and device. Toggle the settings in the [Splatting Basic example](/en-US/examples/splatting-basic/) and [LOD streaming example](/en-US/examples/splatting-lod-stream/) to compare them.

## Splatting Composition and Tone Mapping

`pipeline.Splatting.composite` controls offscreen composition, tone mapping, and exposure for 3DGS. It is independent of the top-level `pipeline.Composite` output composition settings.

```typescript
import { setViewerConfig, ToneMapping } from '@manycore/aholo-viewer';

setViewerConfig(viewer, {
    pipeline: {
        Splatting: {
            enabled: true,
            composite: {
                enabled: true,
                highPrecisionEnabled: true,
                toneMapping: ToneMapping.Neutral,
                exposure: 1,
            },
        },
    },
});
```

| Parameter              | Default              | Description                                                                                               |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`              | `false`              | Enables both offscreen composition and tone mapping. When disabled, the curve and exposure are unused.    |
| `highPrecisionEnabled` | `false`              | Uses an `RGBA16F` intermediate color buffer instead of `RGBA8`. Applies only when composition is enabled. |
| `toneMapping`          | `ToneMapping.Linear` | Tone mapping curve.                                                                                       |
| `exposure`             | `1`                  | Exposure multiplier.                                                                                      |

For offscreen composition without a nonlinear tone curve, use `ToneMapping.Linear` with `exposure: 1`. Setting a curve or exposure does not enable composition; set `composite.enabled: true` explicitly.

## Splatting Configuration Migration

Gaussian falloff now always uses the normalized `fastExp` formula. The `raster.normalizedFalloff` toggle has been removed. The new `raster.detailCullingAlphaEnabled` option defaults to `false`; enable it to include Gaussian opacity in detail culling alongside `raster.detailCullingThreshold`. WebGL and WebGPU use the same setting.

From 1.13, source textures passed to `CompressedSplat` or `SuperCompressedSplat` must have power-of-two widths; invalid widths throw during construction. Custom textures and deserialized sampler data must satisfy this constraint. Enable the new `pack.repackEnabled` option separately and remove the former `pack.sortedLayoutEnabled` setting.

| Previous Setting                         | Migration                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `Splatting.toneMapping.enabled`          | Use `Splatting.composite.enabled`.                                               |
| `Splatting.toneMapping.toneMapping`      | Use `Splatting.composite.toneMapping`.                                           |
| `Splatting.toneMapping.exposure`         | Use `Splatting.composite.exposure`.                                              |
| `Splatting.pack.sortedLayoutEnabled`     | Removed. Delete it from configuration and presets.                               |
| `Splatting.raster.normalizedFalloff`     | Removed. Delete it from configuration and presets; falloff is always normalized. |
| `Splatting.sort.frustumCullingEnabled`   | Removed upstream. Delete it from existing integrations.                          |
| `Splatting.sort.frustumCullingClipScale` | Removed upstream. Delete it from existing integrations.                          |

Tone mapping previously selected a floating-point intermediate buffer implicitly. Set `composite.highPrecisionEnabled: true` explicitly to retain that precision. Remove the separate `Splatting.toneMapping` object.

`SplatUtils.LodConfig.frustumCullingEnabled` still controls unloading of LOD chunks outside the frustum. The new `pixelLimitEnabled` setting defaults to `true` and controls viewport-based sampling limits during refinement. See [Chunk LOD](./chunk-lod.md).
