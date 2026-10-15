---
title: splat-transform
description: Usage guide for splat-transform.
order: 5
---

## Background

`splat-transform` is a 3DGS processing tool for Aholo Viewer. Use it for format conversion, data simplification, LOD generation, and voxel collider generation.

## Environment Requirements

- The npm CLI and JavaScript API require Node.js >= 22.22.1. The standalone C++ executable does not require Node.js.
- Windows: Windows 22H2+, x86_64 or ARM64.
- Linux: x86_64 or ARM64, Ubuntu 22.04 / glibc >= 2.35. The C++ runtime is linked statically.
- macOS: macOS 13+, Apple silicon ARM64.
- GPU features require a user-installed Vulkan 1.1+ loader and compatible driver. macOS also requires a working MoltenVK installation. Packages do not include a Vulkan runtime.

### GPU-Required Features

- SOG generation with SH coefficients. SH0 SOG encoding runs on CPU.
- Voxel generation requires Vulkan GPU support. CPU generation and automatic fallback have been removed.

CPU format conversion and LOD processing do not require Vulkan. Run `splat-transform list:gpu` to list current Vulkan devices. The former Dawn backend could include D3D12 devices, so check saved GPU indices again.

## Format Notes

### Input Formats

- `ply`
- `sog`
- `ksplat`
- `splat`
- `spz`
- `lcc`
- `lcc2`
- `esz`
- `compressed.ply`, the supersplat compressed ply format
- `meta.json`, unpacked sog metadata

### Output Formats

- `ply`
- `spz`
- `uspz`, an spz file without gzip compression
- `splat`
- `sog`
- `esz`

### modify Format

```javascript
{
  isRowMatrix: boolean; // Whether transforms use row matrices. Defaults to true.
  transform: number[]; // Model-level transform.
  deletedIndices: number[]; // Deleted indices in bitmap form.
  indicesTransform: Array<{ indices: number[]; transform: number[] }>; // Local transform list.
}
```

## Usage

### Installation

```bash
npm install @manycore/aholo-splat-transform -g
```

### CLI Mode

```bash
splat-transform create <input> <output> # Convert 3DGS formats.
splat-transform lod:auto --ratio <ratio> <input> <output> # Simplify 3DGS data to the specified ratio [0-1].
splat-transform lod:auto-chunk --type <type:ply,spz,splat,sog,esz> --max-chunk-counts <count> <input> <output> # Generate schedulable multi-level LOD data. --max-chunk-counts controls the maximum chunk size.
```

### Pipeline Mode (Recommended)

```bash
splat-transform pipeline.json
```

The standalone executable also accepts `pipeline.json`, or `-` to read JSON from stdin. The Node CLI converts commands such as `create` and `lod:auto` into the same pipeline. Input and output paths are relative to the process working directory; SOG/LCC/LCC2 resources are relative to their metadata file.

Version 2.0 removes in-memory processing APIs such as `SplatData`, custom task injection, and internal module imports. The JavaScript API retains `run(config, { cwd, signal })` and `enumerateAdapters()`. Processing runs in a child process.

#### Pipeline Descriptor (pipeline.json)

```json
{
    "version": 1,
    "tasks": [
        {
            "id": "0",
            "type": "Read",
            "config": { "inputs": ["a.ply"], "output": "cache0" }
        },
        {
            "id": "1",
            "type": "AutoChunkLod",
            "config": { "input": "cache0", "output": "cache0", "type": "spz" }
        },
        {
            "id": "2",
            "type": "Write",
            "config": { "input": "cache0", "output": "a-lod" }
        }
    ]
}
```

#### Task

<table>
  <tr>
    <th>Name</th>
    <th>Purpose</th>
    <th>Parameter</th>
    <th>Type</th>
    <th>Required (Default)</th>
    <th>Description</th>
  </tr>
  <tr>
    <td rowspan="3">Read</td>
    <td rowspan="3">Reads multiple Gaussian files and merges them into one <code>SplatData</code> object.</td>
    <td>inputs</td>
    <td>string[]</td>
    <td>Y</td>
    <td>Input file paths.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to write.</td>
  </tr>
  <tr>
    <td>maxShDegree</td>
    <td>number<br/>0..=3</td>
    <td>N(3)</td>
    <td>Maximum spherical harmonics degree.</td>
  </tr>
  <tr>
    <td rowspan="4">Write</td>
    <td rowspan="4">Writes a <code>SplatData</code> object to disk in the specified format.</td>
    <td>input</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to read.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Output resource path.</td>
  </tr>
  <tr>
    <td>compressLevel</td>
    <td>number<br/>0..=9</td>
    <td>N(6)</td>
    <td>gzip compression level.</td>
  </tr>
  <tr>
    <td>enableMortonSort</td>
    <td>boolean</td>
    <td>N(true)</td>
    <td>Enables Morton sorting.</td>
  </tr>
  <tr>
    <td rowspan="5">Modify</td>
    <td rowspan="5">Modifies an in-memory splat resource in place.</td>
    <td>input</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to read.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to write.</td>
  </tr>
  <tr>
    <td>modifyPaths</td>
    <td>string[]</td>
    <td>N([])</td>
    <td>modify JSON file paths. See <a href="#modify-format">modify Format</a>.</td>
  </tr>
  <tr>
    <td>rgba</td>
    <td>[number, number, number, number]</td>
    <td>N(unchanged)</td>
    <td>Internal RGBA values; must be finite and fit in float, without clamping or color-space conversion.</td>
  </tr>
  <tr>
    <td>maxShDegree</td>
    <td>0 | 1 | 2 | 3</td>
    <td>N(no truncation)</td>
    <td>Truncates to min(current degree, requested degree); never creates higher SH bands.</td>
  </tr>
  <tr>
    <td rowspan="4">AutoLod</td>
    <td rowspan="4">Generates fused Gaussian output.</td>
    <td>input</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to read.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to write.</td>
  </tr>
  <tr>
    <td>counts</td>
    <td>number</td>
    <td>N(Infinity)</td>
    <td>Maximum retained count.</td>
  </tr>
  <tr>
    <td>ratio</td>
    <td>number<br/>0..=1</td>
    <td>N(0.3)</td>
    <td>Maximum retained ratio.</td>
  </tr>
  <tr>
    <td rowspan="6">AutoChunkLod</td>
    <td rowspan="6">Generates chunked fused Gaussian output for use with the LOD scheduler module.</td>
    <td>input</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to read.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to write.</td>
  </tr>
  <tr>
    <td>type</td>
    <td>string</td>
    <td>Y</td>
    <td>Chunk file type. See <a href="#output-formats">Output Formats</a>.</td>
  </tr>
  <tr>
    <td>forceSpzFormatThreshold</td>
    <td>number</td>
    <td>N(0)</td>
    <td>Because low-count sog chunks can compress poorly, chunks below this threshold are forced to spz. A practical starting value is 200000.</td>
  </tr>
  <tr>
    <td>maxChunkCounts</td>
    <td>number</td>
    <td>N(400000)</td>
    <td>Maximum number of Gaussian points per chunk.</td>
  </tr>
  <tr>
    <td>levels</td>
    <td>
      <pre>
        <code>
Array<{
  precision: number,
  scaleBoost: number
}>
        </code>
      </pre>
    </td>
    <td>
      N
      <pre>
        <code>
[
  { precision: 1.0, scaleBoost: 1 },
  { precision: 0.5, scaleBoost: 1 },
  { precision: 0.25, scaleBoost: 1 },
  { precision: 0.05, scaleBoost: 1.01 },
  { precision: 0.01, scaleBoost: 1.02 },
]
        </code>
      </pre>
    </td>
    <td>LOD level precision settings.</td>
  </tr>
  <tr>
    <td rowspan="8">Voxel</td>
    <td rowspan="8">Generates voxel colliders.</td>
    <td>input</td>
    <td>string</td>
    <td>Y</td>
    <td>Resource key to read.</td>
  </tr>
  <tr>
    <td>output</td>
    <td>string</td>
    <td>Y</td>
    <td>Output file path.</td>
  </tr>
  <tr>
    <td>voxelResolution</td>
    <td>number</td>
    <td>N(0.05)</td>
    <td>Voxel size.</td>
  </tr>
  <tr>
    <td>opacityCutoff</td>
    <td>number</td>
    <td>N(0.1)</td>
    <td>Voxel filtering threshold. Higher values cull voxels more aggressively. Increase it when the scene has many floating artifacts.</td>
  </tr>
  <tr>
    <td>backend</td>
    <td>
      string
      <ul>
        <li>gpu</li>
      </ul>
    </td>
    <td>N(gpu)</td>
    <td>Vulkan GPU only. This field can be omitted. CPU generation and cpuWorkerCount have been removed; GPU errors are returned directly.</td>
  </tr>
  <tr>
    <td>box</td>
    <td>
      <pre>
        <code>
{
  minCorner: [number, number, number],
  maxCorner: [number, number, number]
}
        </code>
      </pre>
    </td>
    <td>
      N
      <pre>
        <code>
{
  minCorner: [-100, -100, -100],
  maxCorner: [100, 100, 100]
}
        </code>
      </pre>
    </td>
    <td>Scene box limit. Outliers can severely affect voxelization performance and produce meaningless output, so this constrains the voxel generation range.</td>
  </tr>
  <tr>
    <td>navCapsule</td>
    <td>
      <pre>
        <code>
{
  height: number,
  radius: number
}
        </code>
      </pre>
    </td>
    <td>N(null)</td>
    <td rowspan="2">
Both fields are used for navigation simplification. <code>navCapsule</code> sets the navigation body height and radius, and <code>navSeed</code> sets the navigation start center.

When enabled, voxels are simplified by the reachable range of the navigation body. This can optimize voxel output, but the feature is still incomplete and may have side effects in some cases, so it is disabled by default.</td>

  </tr>
  <tr>
    <td>navSeed</td>
    <td>
      <pre>
        <code>
{
  x: number,
  y: number,
  z: number
}
        </code>
      </pre>
    </td>
    <td>N(null)</td>
  </tr>
</table>

#### Data Selection and Shared LOD

The following tasks use in-memory resource keys for input/output. Each produces an independent single-block splat resource with complete attributes and SH, offsets [0], counts [result count], and updated bounds.

| Task            | config fields                                        | Behavior                                                                                                                                                  |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select          | input, output; exactly one of indices or indicesPath | Copies indices in first-occurrence order and removes duplicates, such as [8,2,8,5] → [8,2,5], without Morton sorting                                      |
| ReplaceAppend   | input, patch, output, sourceIndices                  | Replaces unique source indices with the first K patch points and appends the remainder; result N+M−K, requiring K≤M and matching SH degrees/layouts       |
| ExtractLodLevel | input, output, required zero-based level             | Copies the level's file/offset/count intervals from the current run's LOD bundle in tree order, preserving repeated references and independent SH storage |

Select accepts a JSON array or an object with indices in .json files. Other files contain little-endian uint32 values; .zst files are decompressed first. JSON indices are validated before conversion, rejecting negative, fractional, boolean, and out-of-range values. Binary lengths must be multiples of four. Empty selection is valid; writing empty data depends on the output format. ReplaceAppend requires sourceIndices, which may be empty but cannot contain duplicates. Retained source, patch, and aliases are unchanged.

Modify validates rgba/maxShDegree first, applies existing patch transforms and deletion, then sets RGBA on the remaining points and truncates SH. A different output key still aliases the same object. For interaction data, call ExtractLodLevel(level:3) before Modify(rgba:[0,0,0,1], maxShDegree:0) to isolate the shared source.

Write the same LOD bundle twice in one pipeline using highPrecision:false followed by highPrecision:true. Each Write reads the resource without consuming it and may parallelize internally. Release only after the final use. The bundle's preserve_order flags still prevent Morton sorting from invalidating intervals. ExtractLodLevel does not restore bundles from disk lod-meta.json files.

#### Examples

Apply modifications to `a.ply` and `b.ply`, then write `c.spz`:

```json
{
    "version": 1,
    "tasks": [
        {
            "id": "0",
            "type": "Read",
            "config": { "inputs": ["a.ply", "b.ply"], "output": "cache0" }
        },
        {
            "id": "1",
            "type": "Modify",
            "config": { "input": "cache0", "output": "cache0", "modifyPaths": ["a.json", "b.json"] }
        },
        {
            "id": "2",
            "type": "Write",
            "config": { "input": "cache0", "output": "c.spz" }
        }
    ]
}
```

Apply a modification to `a.ply`, then generate auto chunk LOD output:

```json
{
    "version": 1,
    "tasks": [
        {
            "id": "0",
            "type": "Read",
            "config": { "inputs": ["a.ply"], "output": "cache0" }
        },
        {
            "id": "1",
            "type": "Modify",
            "config": { "input": "cache0", "output": "cache0", "modifyPaths": ["a.json"] }
        },
        {
            "id": "2",
            "type": "AutoChunkLod",
            "config": { "input": "cache0", "output": "cache0", "type": "spz" }
        },
        {
            "id": "3",
            "type": "Write",
            "config": { "input": "cache0", "output": "a-lod" }
        }
    ]
}
```

Generate voxel colliders:

```json
{
    "version": 1,
    "tasks": [
        {
            "id": "0",
            "type": "Read",
            "config": { "inputs": ["input.ply"], "output": "cache0" }
        },
        {
            "id": "1",
            "type": "Voxel",
            "config": {
                "input": "cache0",
                "output": "voxel-output",
                "voxelResolution": 0.05,
                "opacityCutoff": 0.1,
                "navCapsule": { "height": 1.4, "radius": 0.2 },
                "navSeed": { "x": 0, "y": 0, "z": 0 }
            }
        }
    ]
}
```

## Notes

- A reasonably powerful discrete GPU is recommended when generating `SOG` or generating `Voxel` data with `GPU`. Converting large datasets to `SOG` may require more than 10 GB of GPU memory.
- When generating `chunk-lod` with `AutoChunkLod` or `lod:auto-chunk`, `spz` or `esz` output is recommended. After chunking and multi-level `lod` generation, some chunks can contain very little data. `sog` compresses these small chunks less effectively than `spz`. You can also use `forceSpzFormatThreshold` to force chunks below a chosen count to `spz`.
- `chunk-lod` generation is resource-intensive, so use a relatively powerful machine. For large datasets, memory >= 32 GB and CPU cores >= 16, including hyper-threading, are recommended. If generation cannot complete directly, split the data into coarse chunks first, then generate and merge `lod-meta.json` files. Merging can be done with the `merge-lod` command from `@manycore/aholo-splat-dev-server@>=1.0.1`.
