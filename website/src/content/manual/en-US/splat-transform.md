---
title: splat-transform
description: Usage guide for splat-transform.
order: 5
---

## Background

`splat-transform` is a 3DGS processing tool for Aholo Viewer. Use it for format conversion, data simplification, LOD generation, and voxel collider generation.

## Environment Requirements

- Node.js >= 20.19.0
- Windows: Windows 22H2+ x86_64 with a D3D12 or Vulkan-compatible GPU. A discrete GPU is recommended when GPU features are enabled.
- Linux: x86_64, glibc >= 2.34, libstdc++ >= 3.4.30, and a Vulkan-compatible GPU. A discrete GPU is recommended when GPU features are enabled.
- macOS: not supported.

### GPU-Required Features

- SOG generation.
- Voxel generation when `backend` is set to `gpu`.

## Format Notes

### Input Formats

- `ply`
- `sog`
- `ksplat`
- `splat`
- `spz`
- `lcc`
- `compressed.ply`, the supersplat compressed ply format
- `meta.json`, unpacked sog metadata

### Output Formats

- `ply`
- `spz`
- `uspz`, an spz file without gzip compression
- `splat`
- `sog`

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
splat-transform lod:auto-chunk --type <type:ply,spz,splat,sog> --max-chunk-counts <count> <input> <output> # Generate schedulable multi-level LOD data. --max-chunk-counts controls the maximum chunk size.
```

### Pipeline Mode (Recommended)

```bash
splat-transform pipeline.json
```

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
    <td rowspan="3">Modify</td>
    <td rowspan="3">Modifies a <code>SplatData</code> object.</td>
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
        <li>cpu</li>
        <li>gpu</li>
      </ul>
    </td>
    <td>N(gpu)</td>
    <td>Generation backend. Defaults to gpu; cpu is available but significantly slower. Results can differ slightly between backends.</td>
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

## 注意事项

- 当需要生成`SOG`或者使用`GPU`生成`Voxel`时，推荐使用性能较好的独立显卡。当转换比较大的数据到`SOG`时，需要10GB以上显存。
- 当生成`chunk-lod`时(既使用`AutoChunkLod`或者`lod:auto-chunk`生成)，推荐使用`spz`输出，在分块和多级`lod`后，会存在数据量很少数据量比较小的块，对于这些块`sog`压缩率表现不如`spz`，也可以配置`forceSpzFormatThreshold`来控制小于某个数量的块强制使用`spz`
- `chunk-lod`生成过程中对资源消耗比较大，推荐使用配置比较高的机器配置。对于大型数据推荐内存 >= 32GB, CPU核心数>=16(含超线程)。当无法直接生成时，可以先进行简单的块分割再生成，之后合并`lod-meta.json`，合并可以使用来自`@manycore/aholo-splat-dev-server@>=1.0.1`的`merge-lod`指令。
