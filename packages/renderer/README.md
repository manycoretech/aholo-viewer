# @manycore/aholo-viewer

`@manycore/aholo-viewer` is the full-featured npm package for building browser-based Aholo Viewer applications. It includes the rendering runtime and TypeScript declarations for rendering 3D Gaussian Splatting (3DGS) and mesh content in WebGL/WebGL2-capable browsers.

## Install

```bash
npm install --save @manycore/aholo-viewer
```

The package is ESM-only and ships TypeScript declarations through `dist/index.d.ts`.

## Quick Start

Follow the [Getting Started guide](https://aholojs.dev/en-US/manual/getting-started/) to create a Vite app, initialize a viewer, load a 3DGS splat, and render the first frame.

## Splatting Configuration

Configure offscreen composition and tone mapping through `pipeline.Splatting.composite`:

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

When upgrading, move the former `Splatting.toneMapping` fields into `Splatting.composite` and remove `pack.sortedLayoutEnabled`. Set `composite.highPrecisionEnabled: true` to retain the floating-point intermediate buffer previously enabled by tone mapping. See the [configuration migration guide](https://aholojs.dev/en-US/manual/config/) and [changelog](./CHANGELOG.md) for details.

### Sorting and Texture Repacking

Two opt-in settings are available under `pipeline.Splatting`:

- `sort.radial`: sort by distance from the camera instead of view-direction depth. Defaults to `false`.
- `pack.repackEnabled`: repack WebGL rendering textures in sorted order to reduce indirect texture lookups. Defaults to `false`; it adds GPU memory and a repack pass, so measure it with the target scene and device.

```typescript
setViewerConfig(viewer, {
    pipeline: {
        Splatting: {
            sort: { radial: true },
            pack: { repackEnabled: true },
        },
    },
});
```

From 1.14, WebGL always uses stable sorting on the upper 24 bits of float32 depth keys, matching WebGPU. Remove `sort.highPrecisionEnabled` from configuration and presets; it no longer has any effect.

The WebGL sorting worker uses WebAssembly SIMD and falls back to JavaScript if initialization fails. It reuses splat center data when only the camera changes and the centers remain unchanged, reducing GPU readbacks, and overlaps sorting with sorted-index texture uploads. Compare radial sorting and texture repacking in the [Splatting Basic example](https://aholojs.dev/en-US/examples/splatting-basic/).

Custom source textures supplied to `CompressedSplat` or `SuperCompressedSplat`, including deserialized sampler data, must have power-of-two widths. Invalid widths now throw during construction. `pack.repackEnabled` is a new option; remove the former `pack.sortedLayoutEnabled` setting when upgrading.

### Chunk LOD

For chunk LOD, `SplatUtils.LodConfig.pixelLimitEnabled` defaults to `true`. Set it to `false` to allow refinement beyond the viewport-based sampling limit while retaining the level and point-budget constraints.

## Texture Loading

Use `downloadTexture()` to load standard images, DDS, or KTX2 textures. From 1.14, the bundled Basis Universal transcoder also supports XUASTC and XUBC7 KTX2 textures. XUASTC preserves the matching ASTC block size when transcoded to ASTC; XUBC7 prefers BC7 output when supported by the device.

## Documentation

- Website: https://aholojs.dev/
- Getting Started: https://aholojs.dev/en-US/manual/getting-started/
- API Reference: https://aholojs.dev/en-US/api/
- Examples: https://aholojs.dev/en-US/examples/
- AI-friendly docs: https://aholojs.dev/llms.txt
- AI coding skill: https://github.com/manycoretech/aholo-viewer/blob/master/docs/ai/skills/use-aholo-viewer/SKILL.md

## License

MIT
