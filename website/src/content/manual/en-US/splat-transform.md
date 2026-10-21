---
title: splat-transform
description: splat-transform usage, task parameters, and output formats.
order: 5
---

## Background

`splat-transform` processes 3DGS assets for Aholo Viewer, including format conversion, data selection and modification, LOD generation, and voxel colliders. The npm CLI translates commands into JSON pipelines executed by a standalone C++ process.

## Environment Requirements

- Node.js >= 22.22.1 for the npm CLI and JavaScript API. The standalone executable does not require Node.js.
- Windows: Windows 22H2+, x86_64 or ARM64.
- Linux: x86_64 or ARM64, Ubuntu 22.04 / glibc >= 2.35; the C++ runtime is linked statically.
- macOS: macOS 13+, Apple silicon ARM64.
- GPU acceleration requires a Vulkan 1.1+ loader and compatible driver. macOS also requires MoltenVK. Packages do not include a Vulkan runtime or drivers.

SOG output with SH coefficients uses GPU clustering; SH0 SOG encoding runs on CPU. Other format conversion and LOD processing do not require Vulkan. See [Voxel](#voxel) for backend selection and fallback behavior.

Run `splat-transform list:gpu` to list Vulkan devices. The former Dawn backend could include D3D12 devices, so check saved GPU indices when migrating.

## Format Notes

### Input Formats

| Format                  | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `ply`, `compressed.ply` | Standard PLY and SuperSplat compressed PLY.                                                        |
| `splat`, `ksplat`       | SPLAT and KSPLAT, including multi-section KSPLAT files.                                            |
| `spz`, `uspz`           | SPZ and SPZ without gzip compression.                                                              |
| `sog`, `meta.json`      | A SOG archive or unpacked SOG metadata.                                                            |
| `esz`                   | ESZ v2 with low- or high-precision layouts.                                                        |
| `lcc`, `lcc2`           | Pass the metadata file; LCC2 reads LOD0 and environment splats.                                    |
| `zip`                   | A ZIP containing LCC, LCC2, or SOG resources; not a generic batch input for arbitrary splat files. |

Unpacked SOG/LCC/LCC2 companion resources resolve relative to their metadata file. ZIP resources resolve relative to the metadata path inside the archive, including nested directories. Other pipeline paths resolve relative to the process working directory.

### Output Formats

| Format                  | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `ply`, `splat`          | Standard PLY and SPLAT.                                                                  |
| `spz`, `uspz`           | SPZ v3/v4 and SPZ v3 without gzip compression; configure the version in [Write](#write). |
| `sog`                   | SOG; SH coefficients require GPU clustering.                                             |
| `esz`                   | ESZ v2; `highPrecision` selects the layout. Recommended for chunk LOD.                   |
| LOD / split directories | Created by `AutoChunkLod` or `SplitSplatTask`, then saved with `Write`.                  |
| Voxel directories       | Written directly by `Voxel`, with metadata, binary data, and an optional collision GLB.  |

## Installation and CLI

```bash
npm install @manycore/aholo-splat-transform -g
splat-transform create input.ply output.esz
splat-transform lod:loading --ratio 0.1 input.ply loading.ply
splat-transform lod:flex --score scores.bin --ratio 0.3 input.ply selected.esz
splat-transform lod:auto --ratio 0.3 input.ply simplified.esz
splat-transform lod:auto-chunk --type esz --max-chunk-counts 400000 input.ply lod-output
splat-transform split --type esz --max-chunk-counts 400000 input.ply split-output
splat-transform list:gpu
splat-transform pipeline.json
```

| Command          | Tasks and options                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `create`         | `Read → Modify → Write` for format conversion.                                           |
| `lod:loading`    | `SkeletonLod`; optional `--ratio`.                                                       |
| `lod:flex`       | `FlexLod`; required `--score`, optional `--ratio`.                                       |
| `lod:auto`       | `AutoLod`; optional `--ratio` and `--split-normal`.                                      |
| `lod:auto-chunk` | `AutoChunkLod`; required `--type`, optional `--max-chunk-counts` and `--split-normal`.   |
| `split`          | `SplitSplatTask`; required `--type`, optional `--max-chunk-counts` and `--split-normal`. |
| `list:gpu`       | Lists Vulkan device indices and names.                                                   |

`--type` / `-t` accepts `ply`, `spz`, `splat`, `sog`, or `esz`. `--split-normal` accepts case-insensitive `None`, `X`, `Y`, or `Z`, or the corresponding numbers `0`, `1`, `2`, or `3`. A reference axis keeps blocks unsplit along that axis; for example, `Y` preserves the vertical extent. Use a pipeline for additional parameters. Inspect individual command help with commands such as `splat-transform lod:flex --help`.

Both the npm CLI and the standalone executable accept a pipeline file or `-` for stdin. The standalone executable exposes pipeline execution, `--list-gpu`, `--help`, and `--version`; the command aliases above belong to the npm CLI.

```powershell
Get-Content -Raw pipeline.json | splat-transform -
```

## Pipeline Structure and Resource Lifetime

```json
{
    "version": 1,
    "gpu": 0,
    "tasks": [
        { "id": "read", "type": "Read", "config": { "inputs": ["input.ply"], "output": "source" } },
        {
            "id": "lod",
            "type": "AutoChunkLod",
            "config": { "input": "source", "output": "lod", "type": "esz" },
            "release": ["source"]
        },
        { "id": "write", "type": "Write", "config": { "input": "lod", "output": "lod-output" }, "release": ["lod"] }
    ]
}
```

| Field             | Type / default               | Description                                                                                    |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `version`         | `1`                          | Pipeline version, independent of the SPZ output version.                                       |
| `gpu`             | `number` / `0`               | Device index from `list:gpu` or `enumerateAdapters()`, used when GPU work starts.              |
| `cpuWorkers`      | positive integer / automatic | Global CPU pool worker count; capped at hardware concurrency minus one, with a minimum of one. |
| `tasks`           | `PipelineTask[]`             | Executed in array order. A failed task stops subsequent execution.                             |
| `tasks[].id`      | `string`                     | Task log identifier, required by the TypeScript interface.                                     |
| `tasks[].type`    | `string`                     | A case-sensitive task name listed below.                                                       |
| `tasks[].config`  | `object`                     | Parameters for that task.                                                                      |
| `tasks[].release` | `string[]` / `[]`            | Resource keys removed after the current task succeeds.                                         |

`cpuWorkers` is optional and configured before tasks run. The pool is still created on first use and shared by LOD, clustering updates, file output, CPU voxel jobs, and gzip. Explicit values are capped at `max(1, std::thread::hardware_concurrency() - 1)`, using logical hardware threads; a reported concurrency of 28 allows at most 27 workers. Omitting the field preserves the existing default: half the next power of two of hardware concurrency, clamped to 1–16. Explicit configuration logs the effective count. Zero, negative, fractional, and non-integer values report an error. zstd uses a separate pool initialized with the same worker count.

`Read.output` and processing-task `input` / `output` fields refer to in-memory resource keys for the current run. `Read.inputs`, `Write.output`, and `Voxel.output` are filesystem paths. Relative paths use the process working directory, not the directory containing the pipeline file.

Reusing an output key replaces that resource. `Modify` mutates its input; a different output key remains an alias. Use `Select` or `ExtractLodLevel` to create an independent copy before modifying shared data. `Write` reads the in-memory resource but writes or replaces files on disk. Release a resource only after its final consumer, and do not release an output key needed by subsequent tasks.

Information, progress, and timing logs go to stdout; warnings and errors go to stderr. The standalone executable exits with `0` on success, `1` for pipeline/I/O failures, and `2` for command-line argument errors. Failures do not roll back earlier filesystem output.

## Task Reference

Except for path fields in `Read`, `Write`, and `Voxel`, task `input` and `output` fields are required in-memory resource keys.

### Read

Reads and combines multiple inputs while retaining input-block order for `Modify.modifyPaths`.

| Parameter     | Type / default           | Description                                                |
| ------------- | ------------------------ | ---------------------------------------------------------- |
| `inputs`      | `string[]`, required     | Input file paths.                                          |
| `output`      | `string`, required       | Output resource key.                                       |
| `maxShDegree` | `0 \| 1 \| 2 \| 3` / `3` | Maximum retained SH degree; does not create missing bands. |

### Write

Writes a single splat to a file or a LOD / split bundle to a directory. The output extension or bundle filenames determine the format.

| Parameter          | Type / default      | Description                                                                                             |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `input`            | `string`, required  | Input resource key.                                                                                     |
| `output`           | `string`, required  | Single-file path or bundle output directory.                                                            |
| `enableMortonSort` | `boolean` / `true`  | Applies Morton ordering for output; disabled for bundle files that must preserve interval order.        |
| `version`          | `3 \| 4` / `3`      | Applies to `.spz` only; `.uspz` always writes uncompressed v3.                                          |
| `compressLevel`    | `number`            | SPZ v3 uses gzip, default `6`, typically `0–9`; SPZ v4 uses zstd, default `7`, with zstd's level range. |
| `highPrecision`    | `boolean` / `false` | ESZ only: `false` selects low precision, `true` selects high precision.                                 |

Concurrent CPU bundle file writes are limited to the global CPU pool's worker count, configured through top-level pipeline `cpuWorkers`.

**Directory replacement: writing a bundle recursively removes an existing output directory before recreating it. Use a dedicated output directory.** Filesystem roots and the current working directory are rejected. Single-file output overwrites an existing file.

Write the same LOD bundle to two directories with `highPrecision: false` and `true`. Writes do not consume or modify the in-memory resource and preserve LOD file/offset/count intervals.

### Modify

| Parameter         | Type / default                                 | Description                                                                                              |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `input`, `output` | `string`, required                             | Input and output keys; the output aliases the modified input.                                            |
| `modifyPaths`     | `string[]` / `[]`                              | Patch JSON files in input-block order; an empty string skips that block.                                 |
| `rgba`            | `[number, number, number, number]` / unchanged | Internal float RGBA values; must be finite and fit in float, without clamping or color-space conversion. |
| `maxShDegree`     | `0 \| 1 \| 2 \| 3` / unchanged                 | Truncates to the smaller of the current and requested degree.                                            |

Validates `rgba` / `maxShDegree`, applies patch transforms and deletions, then sets RGBA and truncates SH on the remaining points. Patch files use this structure:

```typescript
interface ModifyPatch {
    isRowMatrix?: boolean; // Defaults to true; matrices contain 16 numbers.
    transform?: number[]; // Input-block transform, defaults to identity.
    deletedIndices?: number[]; // Byte bitmap: point i uses bit (i & 7) in byte[i >> 3].
    indicesTransform?: Array<{ indices: number[]; transform: number[] }>;
}
```

Patch indices are local to the corresponding input block. `deletedIndices` is a bitmap, not a list of point indices.

### Select

| Parameter         | Type               | Description                                                                                                                              |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `input`, `output` | `string`, required | Copies into an independent single-block splat resource.                                                                                  |
| `indices`         | `number[]`         | Specify exactly one of this field or `indicesPath`.                                                                                      |
| `indicesPath`     | `string`           | `.json` accepts an array or `{ "indices": [...] }`; other files contain little-endian uint32 values, with zstd decompression for `.zst`. |

Preserves first-occurrence order and removes duplicates, for example `[8,2,8,5] → [8,2,5]`. Copies complete attributes and SH without Morton sorting. Indices must be valid integers, and binary lengths must be multiples of four. Empty selection is valid; output-format support determines whether an empty result can be written.

### ReplaceAppend

| Parameter                  | Type                 | Description                                          |
| -------------------------- | -------------------- | ---------------------------------------------------- |
| `input`, `patch`, `output` | `string`, required   | Source, patch, and independent output resource keys. |
| `sourceIndices`            | `number[]`, required | Unique source indices; may be empty.                 |

For N source points, M patch points, and K indices, the patch prefix replaces the selected source points and the remainder is appended. The result contains N+M−K points and requires K≤M. Source and patch SH degrees and attribute layouts must match. Inputs and their aliases remain unchanged.

### ExtractLodLevel

| Parameter         | Type               | Description                                                                    |
| ----------------- | ------------------ | ------------------------------------------------------------------------------ |
| `input`, `output` | `string`, required | An in-memory LOD bundle from this pipeline and an independent output resource. |
| `level`           | `number`, required | Zero-based level below the bundle's level count; there is no default level.    |

Copies file/offset/count intervals in `tree` order, retaining repeated references, complete attributes, and independent SH storage. Does not restore a bundle from an on-disk `lod-meta.json` or regenerate LOD.

### SkeletonLod

Generates coarse SH0 data for loading previews.

| Parameter         | Type / default     | Description                     |
| ----------------- | ------------------ | ------------------------------- |
| `input`, `output` | `string`, required | Input and output resource keys. |
| `ratio`           | `number` / `0.1`   | Target retained ratio.          |
| `counts`          | `number` / `85000` | Target point-count limit.       |

The target count is `min(ceil(input count × ratio), counts)`. Actual output may contain fewer points. The CLI command is `lod:loading`.

### FlexLod

Selects points by external scores while retaining their original attributes.

| Parameter         | Type / default         | Description                                                                                |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `input`, `output` | `string`, required     | Input and output resource keys.                                                            |
| `scorePath`       | `string`, required     | Little-endian float32 binary file with at least one score per input point, in input order. |
| `ratio`           | `number` / `0.3`       | Target retained ratio.                                                                     |
| `counts`          | `number` / unlimited   | Limits the target count together with `ratio`.                                             |
| `originalIndices` | `string` / not written | Optional output path for retained source indices as little-endian uint32.                  |

Selects the highest-scoring `min(ceil(input count × ratio), counts)` points. Equal scores retain input order; the final selection is sorted by source index. The CLI command is `lod:flex --score scores.bin`.

### AutoLod

Fuses Gaussians to generate simplified data.

| Parameter         | Type / default                     | Description                                         |
| ----------------- | ---------------------------------- | --------------------------------------------------- |
| `input`, `output` | `string`, required                 | Input and output resource keys.                     |
| `ratio`           | `number` / `0.3`                   | Target retained ratio, normally `0–1`.              |
| `counts`          | `number` / unlimited               | Limits the target count together with `ratio`.      |
| `splitNormal`     | `None/X/Y/Z` or `0/1/2/3` / `None` | Block reference axis; strings are case-insensitive. |

The target count is `min(ceil(input count × ratio), counts)`. Small-block stopping conditions and iteration limits can leave more points than requested. The CLI command is `lod:auto`.

### AutoChunkLod

Generates a multi-level bundle containing `lod-meta.json`; save it with `Write`. See [Chunk LOD](./chunk-lod.md) for runtime integration.

| Parameter         | Type / default                     | Description                                                                         |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `input`, `output` | `string`, required                 | Input and output bundle resource keys.                                              |
| `type`            | `string`, required                 | Chunk format; `esz` is recommended.                                                 |
| `maxChunkCounts`  | `number` / `400000`                | Controls initial block size and must be positive; merged level files can be larger. |
| `splitNormal`     | `None/X/Y/Z` or `0/1/2/3` / `None` | Block reference axis.                                                               |
| `levels`          | `ChunkLevel[]` / below             | A custom array replaces the complete default array.                                 |

```json
[
    { "precision": 1.0, "scaleBoost": 1 },
    { "precision": 0.5, "scaleBoost": 1 },
    { "precision": 0.25, "scaleBoost": 1 },
    { "precision": 0.05, "scaleBoost": 1.01, "merged": true, "permanent": true },
    { "precision": 0.01, "scaleBoost": 1.02, "merged": true, "permanent": true }
]
```

| Level field  | Default  | Description                                                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `precision`  | Required | Target retained ratio relative to the original data. Level 0 retains the source and should use `1`; subsequent levels decrease. |
| `scaleBoost` | `1`      | Gaussian scale multiplier after simplification, used to reduce gaps in coarse levels.                                           |
| `merged`     | `false`  | Combines blocks from this level not already assigned to output files, preserving interval order.                                |
| `permanent`  | `false`  | Adds files referenced by this level to `permanentFiles` for runtime residency.                                                  |

Omitting `merged` / `permanent` in a custom array means `false`; it does not inherit `true` from the last two default levels. Voxel output associated with the same source automatically adds relative `voxels` paths to LOD metadata, whether Voxel runs before or after the LOD writes.

### SplitSplatTask

Splits data without generating multiple LOD levels or `lod-meta.json`. The output bundle contains files such as `block_0.<type>` and is saved to a directory by `Write`.

| Parameter         | Type / default                     | Description                               |
| ----------------- | ---------------------------------- | ----------------------------------------- |
| `input`, `output` | `string`, required                 | Input and output bundle resource keys.    |
| `type`            | `string`, required                 | Block format; `esz` is recommended.       |
| `maxChunkCounts`  | `number` / `400000`                | Controls block size and must be positive. |
| `splitNormal`     | `None/X/Y/Z` or `0/1/2/3` / `None` | Block reference axis.                     |

### Voxel

Writes a voxel directory directly from a splat resource; no subsequent `Write` is needed. See [Physics Collision](./physics-collision.md) for the file format.

| Parameter           | Type / default                               | Description                                                                                                            |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `input`             | `string`, required                           | Input splat resource key.                                                                                              |
| `output`            | `string`, required                           | Voxel output directory.                                                                                                |
| `voxelResolution`   | `number` / `0.05`                            | Finite positive voxel edge length, in input-coordinate units.                                                          |
| `opacityCutoff`     | `number` / `0.1`                             | Occupancy threshold in `0–1`; higher values remove more low-density regions.                                           |
| `backend`           | `gpu \| cpu` / `gpu`                         | Compute backend; see fallback rules below.                                                                             |
| `box`               | `{ minCorner: [x,y,z], maxCorner: [x,y,z] }` | Defaults to `[-100,-100,-100]` through `[100,100,100]`; limits the generated region.                                   |
| `filterCluster`     | `boolean \| object` / `true`                 | Prefilters a primary connected region; `false` disables it. Object fields are listed below.                            |
| `autoDenseBox`      | `boolean \| object` / `true`                 | Attempts to tighten bounds inflated by scale outliers.                                                                 |
| `compression`       | `none \| gzip \| zstd` / `none`              | Binary compression; produces `.bin`, `.bin.gz`, or `.bin.zst`.                                                         |
| `nodeEncoding`      | `raw \| compact` / `raw`                     | Octree node encoding; compact data must be decoded to the runtime node layout.                                         |
| `collisionMesh`     | `boolean \| smooth \| faces` / `false`       | `true` means `smooth`; `faces` emits voxel surfaces, while `smooth` uses marching cubes and merges coplanar triangles. |
| `floorFill`         | `boolean` / `false`                          | Fills upward from the bottom of the grid to the floor.                                                                 |
| `floorFillDilation` | `number` / `0`                               | Nonnegative horizontal dilation distance for `floorFill`.                                                              |
| `navExteriorRadius` | `number` / `0`                               | Nonnegative exterior-fill dilation distance; requires `navSeed`.                                                       |
| `navSeed`           | `{ x, y, z }` / unset                        | Navigation seed in scene coordinates for exterior fill and capsule navigation.                                         |
| `navCapsule`        | `{ height, radius }` / unset                 | Enables capsule navigation when `height > 0` and `navSeed` is set; `radius` must be nonnegative.                       |

GPU is preferred by default. Each Voxel task initializes the selected Vulkan device when resolving its backend. If initialization fails, it logs a warning and selects CPU for cluster filtering, main generation, and navigation. Explicit `backend: "cpu"` never attempts Vulkan initialization. Once selected, the backend stays fixed: GPU compute errors propagate, and empty results do not trigger CPU retries. Invalid parameters or files and CPU processing failures still report errors. The process-wide pool manages worker counts; the former `cpuWorkerCount` option is no longer used.

`filterCluster` object fields:

| Field             | Default                | Description                                                                                                                                    |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `voxelResolution` | `1`                    | Prefilter grid voxel edge length.                                                                                                              |
| `opacityCutoff`   | `0.999`                | Prefilter occupancy threshold.                                                                                                                 |
| `minContribution` | `0.1`                  | Minimum Gaussian contribution to the selected connected region.                                                                                |
| `seed`            | `{ x: 0, y: 0, z: 0 }` | Connected-region seed. If omitted and too few points remain, other large connected regions are considered. Explicit seeds disable that search. |

`autoDenseBox` object fields:

| Field                    | Default | Description                                                                          |
| ------------------------ | ------- | ------------------------------------------------------------------------------------ |
| `targetCenterKeepRatio`  | `0.98`  | Target center retention when estimating dense bounds.                                |
| `minimumCenterKeepRatio` | `0.95`  | Minimum center retention required to accept tighter bounds.                          |
| `minimumAxisInflation`   | `1.5`   | Axis inflation threshold for Gaussian bounds relative to center bounds.              |
| `minimumVolumeInflation` | `4`     | Volume inflation threshold; reaching either inflation threshold triggers an attempt. |

When grid or octree indices exceed capacity, generation may retry with a larger voxel edge length. Use `voxel-meta.json.voxelResolution` as the effective value. `Voxel` creates its directory and overwrites matching files without clearing the directory; use metadata `files` after changing compression. No `collision.glb` is written when the generated mesh has no triangles.

## Pipeline Examples

### Merge and Modify

```json
{
    "version": 1,
    "tasks": [
        { "id": "read", "type": "Read", "config": { "inputs": ["a.ply", "b.ply"], "output": "source" } },
        {
            "id": "modify",
            "type": "Modify",
            "config": { "input": "source", "output": "source", "modifyPaths": ["a.json", "b.json"] }
        },
        {
            "id": "write",
            "type": "Write",
            "config": { "input": "source", "output": "combined.esz" },
            "release": ["source"]
        }
    ]
}
```

### Shared LOD, Interaction Data, and Voxels

Retain the source while creating a LOD bundle. Extract level 3 and modify only that copy. Low- and high-precision LOD outputs share the bundle. The final voxel task associates its output with metadata in both LOD directories.

```json
{
    "version": 1,
    "tasks": [
        { "id": "read", "type": "Read", "config": { "inputs": ["input.ply"], "output": "source" } },
        { "id": "lod", "type": "AutoChunkLod", "config": { "input": "source", "output": "lod", "type": "esz" } },
        {
            "id": "extract",
            "type": "ExtractLodLevel",
            "config": { "input": "lod", "output": "interaction", "level": 3 }
        },
        {
            "id": "modify",
            "type": "Modify",
            "config": { "input": "interaction", "output": "interaction", "rgba": [0, 0, 0, 1], "maxShDegree": 0 }
        },
        {
            "id": "interaction",
            "type": "Write",
            "config": { "input": "interaction", "output": "interaction.esz" },
            "release": ["interaction"]
        },
        { "id": "low", "type": "Write", "config": { "input": "lod", "output": "lod-low", "highPrecision": false } },
        {
            "id": "high",
            "type": "Write",
            "config": { "input": "lod", "output": "lod-high", "highPrecision": true },
            "release": ["lod"]
        },
        {
            "id": "voxel",
            "type": "Voxel",
            "config": {
                "input": "source",
                "output": "voxel-output",
                "backend": "cpu",
                "voxelResolution": 0.05,
                "compression": "gzip",
                "nodeEncoding": "raw",
                "collisionMesh": "smooth"
            },
            "release": ["source"]
        }
    ]
}
```

### Select and Replace

```json
{
    "version": 1,
    "tasks": [
        { "id": "read", "type": "Read", "config": { "inputs": ["input.ply"], "output": "source" } },
        { "id": "select", "type": "Select", "config": { "input": "source", "output": "patch", "indices": [0] } },
        { "id": "modify", "type": "Modify", "config": { "input": "patch", "output": "patch", "rgba": [0, 0, 0, 1] } },
        {
            "id": "replace",
            "type": "ReplaceAppend",
            "config": { "input": "source", "patch": "patch", "output": "result", "sourceIndices": [0] },
            "release": ["source", "patch"]
        },
        {
            "id": "write",
            "type": "Write",
            "config": { "input": "result", "output": "result.esz" },
            "release": ["result"]
        }
    ]
}
```

This example requires at least one input point. The patch retains its SH degree because `ReplaceAppend` rejects mismatched source and patch degrees.

## JavaScript API

```javascript
import { run, PipelineError } from '@manycore/aholo-splat-transform';

const controller = new AbortController();
// Call controller.abort() when the caller requests cancellation.
try {
    await run(
        {
            version: 1,
            tasks: [
                { id: 'read', type: 'Read', config: { inputs: ['input.ply'], output: 'source' } },
                { id: 'write', type: 'Write', config: { input: 'source', output: 'output.esz' }, release: ['source'] },
            ],
        },
        { cwd: process.cwd(), signal: controller.signal },
    );
} catch (error) {
    if (error instanceof PipelineError) {
        console.error('Pipeline failed:', error.exitCode, error.signal);
    } else if (error instanceof Error && error.name === 'AbortError') {
        console.error('Pipeline cancelled');
    }
    throw error;
}
```

`run()` returns `Promise<void>`. `enumerateAdapters({ cwd, signal })` returns Vulkan devices with `index`, `name`, `backend: "vulkan"`, `vendorId`, `deviceId`, `apiVersion`, and `uuid`. Enumeration itself requires Vulkan.

`PipelineError` represents a nonzero child exit or termination signal. Process-start failures and `AbortSignal` cancellation can reject with a regular Error / AbortError. SIGINT and SIGTERM are forwarded to the child. Use `resolveExecutable()` to locate the native executable or set `SPLAT_TRANSFORM_EXECUTABLE` to an absolute local build path. If a platform executable is missing, check that npm optional dependencies are enabled.

The package exports `PipelineConfig`, `PipelineTask`, `TaskType`, `RunOptions`, `VulkanAdapter`, and `ModifyConfig`, `SelectConfig`, `ReplaceAppendConfig`, `ExtractLodLevelConfig`, and `VoxelConfig`. `PipelineTask.config` remains `Record<string, unknown>`; use the reference above for complete parameters.

## Migration and Resource Guidance

Version 2.0 removes in-memory APIs such as `SplatData`, `injectCustomTask`, and deep module imports. Data remains in the native child process and is processed through the CLI, version 1 pipelines, and `run()`.

- Use `esz` for chunk LOD: set `type: "esz"` in a pipeline or pass `--type esz` to the CLI.
- SOG clustering batches work according to the available Vulkan memory budget and device limits, streaming data as needed. There is no universal 10 GB requirement, but insufficient working-buffer memory still causes an error. Random clustering can produce different results across repeated SOG exports.
- Large LOD and voxel jobs require sufficient system memory. Release resources after their final consumer, limit concurrent bundle writes, and tune chunk sizes and voxel resolution for the scene.
- CPU and GPU voxel occupancy can differ near thresholds. Selecting CPU after device initialization fails allows generation without an available GPU, but does not guarantee bit-identical results across backends.
