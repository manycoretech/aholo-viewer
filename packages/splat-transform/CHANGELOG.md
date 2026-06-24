# Changelog

## DEV

- Add a `compression` option for voxel binary output with `none`, `gzip`, and `zstd` modes.
- Improve voxel robustness with a `filterCluster` fallback for weak default seeds and automatic dense bounds for scale outliers.

## 1.4.2

- fix typo in `list:gpu` output

## 1.4.1

- add `list:gpu` command

## 1.4.0

- upgrade `commander` to `15.0.0`
- add `win32-arm64` pre build binary

## 1.3.2

- try fix linux-arm64 issues by upgrade clang

## 1.3.1

- fix block split

## 1.3.0

- update license to MIT and OPEN SOURCE

## 1.2.11

- Remove the `webgpu` dependency and switch to a self-built version.
- Optimize `k-means` computation with `vec4` alignment and simplified Euclidean distance calculation. Performance improves by about 50%.
- Optimize `clusterAverage` to reduce JavaScript-side overhead.
- Share the native thread pool.

## 1.2.10

- Add a prebuilt `osx-arm64` package.

## 1.2.9

- Improve the coding style by enabling `verbatimModuleSyntax` and `isolatedModules`, and migrate to `OXC`.
- Improve native module loading.
- Update the voxel output format version to 1.2. Add gzip compression and a compact encoding mode; both are disabled by default.
- Enable `filterCluster` prefiltering for voxel output by default.

## 1.2.8

- Upgrade to `typescript@^6.0.3`.
- Prevent `WebP` encoding from compressing fully transparent data.
- Add support for `spz v4` input and output. The default remains v3.
- Add support for `esz` input and output.

## 1.2.7

- Add `maxShDegree` parameter support to `ReadTask`.

## 1.2.6

- Add a CPU implementation for voxelization and optimize several algorithms.
- Optimize the voxel output format.

## 1.2.5

- Fix a LOD construction error when `SplatData.counts = 0`.

## 1.2.4

- Add support for generating voxel colliders.
- Add multitask support for AVIF encoding and decoding.
- Build the Linux version with glibc.
- Fix LOD chunk generation failures for small files.
- Optimize the logger.

## 1.2.3

- Optimize internal code and remove unused implementations.
- Update the `chunk-lod` forward box calculation to match application requirements.

## 1.2.2

- Add `libavif`.
- Reorganize the file structure and remove the `IData` structure.
- Fix delete failures caused by conflicts between `modify` and `chunk-lod`.

## 1.2.1

- Add `GPU` device selection support.
- Add `MortonSort` support to `write` to improve the compression ratio.

## 1.2.0

- Refactor CLI commands.
- Change the underlying implementation to composable pipeline tasks, reducing the number of saved files.
- Use double precision for intermediate calculations and remove invalid code.
- Add `getOrCreateDevice` for sharing GPU devices.
- Improve `auto-lod` so it stays closer to the target value.
- Optimize output.

## 1.1.2

- Add the nanogs search algorithm.
- Add the `--max-chunk-counts` parameter.

## 1.1.1

- Optimize LOD parameters to avoid long-running execution.

## 1.1.0

- Update CLI invocation parameters.
- Optimize `lod:auto` to avoid OOM issues caused by delayed memory release.
- Add the `lod:auto-chunk` command.
- Add exponential stepping support for multi-level LOD.
- Optimize `auto-chunk` output.

## 1.0.8

- Optimize Gaussian spatial partitioning.
- Optimize Gaussian bounding boxes and remove data with excessive offsets.
- Fix incorrect `quality` parsing for lossy `webP` encoding.
- Fix LOD command errors.
- Optimize `cluster_average` parallel granularity.

## 1.0.7

- Add support for SOG output.

## 1.0.6

- Optimize built-in LOD parameters.

## 1.0.5

- Optimize built-in LOD parameters.

## 1.0.4

- Fix an error when `create` parses `deletedIndicesBitMap`.

## 1.0.3

- Optimize `autoLod` results and implementation.

## 1.0.2

- Add streaming parsing and writing support to reduce memory usage.
- Add `autoLod` support for generating LOD results from 3DGS data.
    - `splat-transform lod --type auto --ratio 0.3 simiao.ply simiao-lod.spz`

## 1.0.1

- Add `bin.est` to avoid conflicts when used together with `@playcanvas/splat-transform`.

## 1.0.0

- Publish the first stable package.
