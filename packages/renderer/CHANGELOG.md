# ChangeLOG

## 1.7.1

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
