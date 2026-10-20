# ChangeLOG

## 1.11.0

1. Features
    - add `SplatState.DisableSH` to disable view-dependent spherical-harmonic color contributions for individual splats while retaining their base color.
    - add `SplatUtils.LodConfig.pixelLimitEnabled`, enabled by default, to control the viewport-based sampling limit; disabling it allows further refinement within the existing level and point-budget constraints.
2. Fixes
    - preserve TypedArray `byteOffset` and `byteLength` when converting between splat samplers and `SourceTexture`.
    - decode image-backed splat data textures with `createImageBitmap`, with color-space conversion and alpha premultiplication disabled to preserve encoded data.
3. Breaking Changes
    - remove `Splatting.pack.sortedLayoutEnabled`; delete it from renderer configuration and presets.
    - remove the upstream `Splatting.sort.frustumCullingEnabled` and `Splatting.sort.frustumCullingClipScale` settings. `SplatUtils.LodConfig.frustumCullingEnabled` remains available for chunk unloading.
    - move `Splatting.toneMapping.toneMapping` and `Splatting.toneMapping.exposure` to `Splatting.composite.toneMapping` and `Splatting.composite.exposure`.
    - remove `Splatting.toneMapping.enabled`; `Splatting.composite.enabled` now controls both offscreen composition and tone mapping. Set `composite.highPrecisionEnabled: true` explicitly to retain the floating-point intermediate buffer previously used by tone mapping. For composition without a nonlinear tone curve, use `ToneMapping.Linear` with `exposure: 1`.

## 1.10.0

1. Features
    - support loading and merging multiple splat files from ZIP archives through `SplatLoader.parseSplatData()`; `SplatPackType.Sog` remains limited to a single SOG asset.
    - add `extras.includeOtherFormats` to include other independent splat formats from ZIP archives; defaults to `false`, loading only the requested format.
    - support optional voxel-based occlusion downgrading in `SplatUtils.LodSplat` through `LodMeta.voxels` and a `parseVoxel` constructor callback.
    - add `LodConfig.movingMinLevel` to limit new LOD refinement while the camera is moving; defaults to `2`, with `0` representing the finest level.
    - expose `LodSplat.flush()` and add `LodSplat.stop()` for application-managed frame loops, and support an optional render-pixel viewport in `LodSplat.tick(camera, viewport)`.
2. Fixes
    - release LOD GPU resources on destruction and failed resource preparation while preserving textures still shared by active splats.
    - propagate LOD resource loading and replacement failures through `LodSplat.onFinishSchedule()`.
3. Changes
    - reorganize splat-loader utilities and centralize ZIP extraction and resource path resolution for SOG, LCC, and LCC2 assets.
    - allocate LOD detail by projected screen area and splat budget, with a viewport-based sampling limit when a viewport is available.
    - prioritize coarse scene coverage, pace detail updates and node merging, and validate pending LOD replacements before retiring displayed splats.
    - pass an optional `AbortSignal` to custom LOD resource loaders, cancel unused requests, and retain idle resources within a point-count budget.
    - measure `LodConfig.hysteresisTicks` as elapsed time in nominal 60 Hz ticks, independent of how often `LodSplat.tick()` is called.
    - reduce redundant splat repacking and texture reallocations during LOD updates.
4. Breaking Changes
    - change low-level `SplatLoader.SogFile`, `SplatLoader.LccFile`, and `SplatLoader.Lcc2File` readers to consume metadata streams, with a file context for archive resources; use `SplatLoader.parseSplatData()` to load ZIP archives.
    - remove `LodConfig.backgroundPenalty` and `LodConfig.distanceStep`; use `minLevel`, `movingMinLevel`, and `maxBudget` to control LOD detail under the new allocation strategy.

## 1.9.0

1. Features
    - add LCC2 loading through `SplatLoader.SplatFileType.LCC2`, with `parseSplatData()` supporting `extras.lodLevel` to select the LOD level; defaults to `0`.
    - support 2D float and unsigned integer `SourceTexture` inputs in `SplatModifier`, including texture updates through `update()`.
2. Fixes
    - handle asynchronous splat sorting failures and cancel pending work when the renderer is destroyed or its context is lost.
    - detect LCC metadata with any `.lcc` filename inside ZIP archives.

## 1.8.1

1. Fixes
    - fix quaternion decoding in `CompressedSplatData` for compressed splat data.

## 1.8.0

1. Features
    - add and export the `XR` namespace.
    - add `LodSplat.setModifiers()` for applying `SplatModifier` instances to LOD splats.
    - add `LodConfig.frustumCullingEnabled` to control unloading LOD blocks outside the camera frustum; enabled by default.
2. Changes
    - update the default LOD distance step to `{ distance: 10, step: 2 }` and improve scheduling for large scenes.
3. Breaking Changes
    - remove `LodConfig.outsidePenalty`, `behindPenalty`, `behindTolerance`, and `behindDistanceTolerance`.

## 1.7.2

1. Changes
    - update the `SplatModifier` shader block factory callback to receive `language: 'wgsl' | 'glsl'` instead of `isWebgpu: boolean`.

## 1.7.0

1. Features
    - add and export `SplatModifier` for composing custom shader-based splat rendering and animation behavior.
    - add `Splat.setModifiers()` for attaching modifiers and updating their uniform values at runtime.
2. Changes
    - use `SplatModifier` for LOD debug coloring.
3. Breaking Changes
    - remove subgroup transform support, including `Splat.groupTex` and `Splat.groupTransformTex`.

## 1.6.2

1. Fixes
    - fix ESZ and SOG image decoding when the encoded image data uses a sliced buffer.
    - fix Zstandard parsing for small files.
2. Changes
    - set the maximum splat parsing worker count to one fewer than `navigator.hardwareConcurrency`.

## 1.6.1

1. Features
    - add `SplatUtils.LodConfig.mergeNodeEnabled` to control LOD node merging and reduce scheduling peaks.
2. Fixes
    - fix incomplete LOD coverage when the total splat count of the lowest levels exceeds `maxBudget`.

## 1.6.0

1. Features
    - add ESZ v2 splat loading with a Zstandard streaming container and low/high layout support.
    - optimize SPZ v4 loading with streaming parsing to reduce parse time and peak worker memory.
2. Fixes
    - fix `SplatReorderMaterial` mobile compatibility by packing splat reorder ranges into `ivec4` uniforms.
    - fix `SuperCompressedSplatData` SH quantization overflow and second-order SH coefficient offsets.
    - fix worker message cleanup.
3. Changes
    - upgrade bundled EGS packages to standard ESM packaging with limited public package exports.
    - optimize splat stream parsing to reduce intermediate buffers and data copies.
    - ESZ v1 files are no longer supported.

## 1.5.1

1. Fixes
    - fix `lod` scheduling to avoid temporarily creating too many active splats.
2. Changes
    - move splat sorting ownership to `SplatUtils`; `SplatLoader` now only parses files.

## 1.5.0

1. Features
    - add `Splatting.pack.forceUnstableEnabled` to force the complete rendering pipeline.
    - add `Splatting.sort.frustumCullingEnabled` to pre-cull splats for better performance.
        - this can make black borders during camera rotation more visible, so enable it carefully in production scenes.
    - add `Limits` for describing `IRenderer` limits.
        - some `Capabilities` fields are now marked as deprecated.
    - add `lod.proxy` to reduce the number of runtime `Splat` objects.
        - reduces `pack` and `precalculate` GPU cost by 50%-90% in real scenes.
2. Fixes
    - fix `SplatHighlightKernel` highlights being offset when `cameraRelativeEnabled` is enabled.
    - fix `clear` not taking effect correctly when `MRT` is enabled.
    - fix invalid data when using low-precision packing.
    - fix the `LodMeta.version` type definition.
3. Changes
    - optimize texture-size calculation to improve rendering performance for scenes with a single `Splat` object.
    - move sorting to a dedicated worker to avoid long parsing tasks blocking sorting.

## 1.4.1

1. Fixes
    - fix `packCameraRelativeCenterIsDirty` being incorrectly evaluated as `true` when camera-relative center packing is disabled.

## 1.4.0

1. Features
    - add `texture-loader`, now `downloadTexture` is a generic texture load
        - supported types: image types(png, jpg, webp, etc...), ktx2 and dds
    - add grouped `Splatting` config: `pack`, `raster`, `sort`, and `composite`.
    - add high-precision and camera-relative splat packing, plus high-precision sorting.
    - `combineSplatData` target `SplatData` support.
2. Changes
    - adjust splat-related default parameters from the underlying renderer pipeline.

## 1.3.0

1. Features
    - `SplatUtils`add support for `center` and `ellipsoid`
        > **`constructor` has been changed, migrate: `new SplatBVH(operator)` -> `new BVH(SplatCenterPrimitiveSource(operator))`**
2. Fixes
    - `SplatUtils`state texture type change to `r8uint`

## 1.2.9

1. Features
    - use `api-extractor` to rollup dts.
    - add `esz` and `spzV4` format support.
2. Fixes
    - fix typing for `MeshBasicMaterial.setValues`
    - fix typing for `MeshPhongMaterial.setValues`
    - Simplify some material typings
    - fix type only classes
    - cleanup `package.json`

## 1.1.0

1. Features
    - upgrade packages: `typescript@^6.0.3`, `tslib@^2.8.1`
    - sync base packages
    - remove unused module `render-cloud`

## 1.0.0

1. Features
    - First release
