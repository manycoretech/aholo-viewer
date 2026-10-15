# splat-transform

Gaussian splat conversion, LOD generation, and voxel collision data for Aholo Viewer.

The processing engine is a standalone C++20 executable. The npm package translates the existing CLI commands into JSON pipelines and starts that executable. Vulkan compute uses Vulkan-Hpp RAII and VMA.

## Requirements

- Node.js >= 22.22.1 for the npm CLI and JavaScript wrapper. The native executable does not require Node.
- Windows 22H2 or later: x64 or ARM64.
- Linux: x64 or ARM64, Ubuntu 22.04 / glibc 2.35 or later. The C++ runtime is linked statically.
- macOS 13 or later: Apple silicon ARM64.
- GPU operations require a user-installed Vulkan 1.1+ loader and a compatible driver. macOS additionally requires a working MoltenVK installation. The packages do not include a Vulkan runtime or GPU drivers.

CPU operations start without Vulkan. SOG output with SH coefficients requires GPU clustering; SH0 SOG encoding runs on CPU. Voxel generation requires Vulkan and reports GPU failures directly. The CPU generation backend and cpuWorkerCount option have been removed.

SOG clustering reuses GPU resources across iterations and uses the available Vulkan memory budget to keep as much point data resident as fits. Remaining data streams through reusable slots. Batch sizes follow memory capacity and device buffer/workgroup limits. Memory scheduling is automatic and preserves the existing pipeline JSON parameters; staging and driver memory are additional. See the native build instructions for budget details.

LOD, clustering updates, bundle writing, SOG texture encoding, and gzip jobs reuse one CPU pool created on first use. SOG generates archive members in parallel and assembles the final ZIP with libzip. zstd compression contexts share a separate, bounded pool supplied by zstd. Large gzip and zstd outputs remain standard single-member/single-frame streams.

## Install and run

```sh
npm install @manycore/aholo-splat-transform -g
splat-transform --help
splat-transform create input.ply output.spz
splat-transform lod:auto --ratio 0.3 input.ply output.ply
splat-transform lod:auto-chunk --type esz input.ply output-directory
splat-transform split --type ply input.ply output-directory
splat-transform list:gpu
splat-transform pipeline.json
```

GPU indices now identify Vulkan devices. Run list:gpu again when migrating a saved configuration: indices from the former Dawn backend can include D3D12 adapters and are not interchangeable.

Both the npm CLI and the native executable accept a pipeline file or a single dash for JSON on stdin. The npm CLI forwards the file path or stdin directly to the native process, which reads and validates the JSON. Paths inside a pipeline remain relative to the process working directory. Referenced SOG/LCC/LCC2 assets resolve relative to their metadata files.

```json
{
    "version": 1,
    "tasks": [
        { "id": "read", "type": "Read", "config": { "inputs": ["input.ply"], "output": "data" } },
        { "id": "write", "type": "Write", "config": { "input": "data", "output": "output.spz" }, "release": ["data"] }
    ]
}
```

Supported tasks are Read, Write, Modify, Select, ReplaceAppend, ExtractLodLevel, SkeletonLod, FlexLod, AutoLod, AutoChunkLod, SplitSplatTask, and Voxel. Version 1 task configuration fields and defaults remain supported except the removed CPU voxel options. GPU enumeration uses the native executable's standalone `--list-gpu` command through `enumerateAdapters()` and does not enter the pipeline. Task logs keep the 1.x prefixes, counts, LOD summaries, file progress, and timing labels. Information, progress, and timing logs go to stdout; warnings and errors go to stderr.

Inputs: PLY, compressed PLY, SPLAT, KSPLAT, SPZ/USPZ, SOG and unpacked SOG metadata, ESZ, LCC/LCC2, and their supported ZIP resource layouts. Outputs: PLY, SPLAT, SPZ v3/v4, USPZ, SOG, ESZ low/high precision, LOD directories, and voxel raw/compact binaries with optional gzip/zstd compression and collision GLB.

## Pipeline data tasks

- Modify accepts optional `rgba: [r, g, b, a]` and `maxShDegree: 0 | 1 | 2 | 3`. It validates both fields before applying existing patches, applies RGBA to the remaining points, then truncates SH. RGBA uses internal finite float values without clamping or color-space conversion. Omitted fields preserve existing behavior. Modify mutates its input; a different output key remains an alias.
- Select accepts `input`, `output`, and exactly one of `indices` or `indicesPath`. Files may contain a JSON array, `{ "indices": [...] }`, little-endian uint32 values, or zstd-compressed uint32 values with a `.zst` suffix. Selection preserves first-occurrence order, removes duplicates, and copies complete attributes and SH. Invalid integer values and ranges are rejected before conversion; empty selection is valid.
- ReplaceAppend accepts `input`, `patch`, `output`, and required `sourceIndices` (which may be empty). The patch prefix replaces those unique source indices; the remainder is appended. Both inputs must have matching SH degrees and attribute layouts. Retained inputs and aliases remain unchanged.
- ExtractLodLevel accepts `input`, `output`, and required zero-based `level`. It copies `tree[*].lods[level]` intervals from an in-memory LOD bundle in metadata order, including repeated intervals. The result has independent SH storage. It does not load a LOD directory from disk or regenerate LOD.

All three new tasks produce independent single-block splat resources. Write remains read-only: write low- and high-precision ESZ from the same bundle using two Write tasks in one pipeline, with `highPrecision: false` and `true`. Release the bundle only after its final consumer. Bundle `preserve_order` flags still override Morton sorting. For interaction data, extract the requested level before applying black RGBA and SH0 to the copy.

LOD output metadata includes optional `voxels: string[]` when the same pipeline successfully writes voxels from the same input or its derived models. Each entry points to `voxel-meta.json` relative to that LOD metadata directory. Associations survive simplification, LOD extraction, and resource release; repeated writes compute their own relative paths without changing the in-memory bundle. Voxel tasks may run before or after LOD writes. Unrelated inputs remain separate, duplicate output paths are removed, and the field is omitted when no associated voxel output exists.

## JavaScript API

```js
import { run, enumerateAdapters } from '@manycore/aholo-splat-transform';

await run({ version: 1, tasks: [] });
const adapters = await enumerateAdapters();
```

run accepts optional cwd and AbortSignal options. Failures reject with PipelineError, which exposes exitCode and signal. SIGINT and SIGTERM are forwarded to the child process. Set SPLAT_TRANSFORM_EXECUTABLE to an absolute executable path to use a local CMake build.

Version 2 removes injectCustomTask, SplatData and other in-memory processing APIs, and deep module imports. Pipeline data stays inside the native process. CLI commands and version 1 pipeline files remain the supported processing interface.

The package exports `ModifyConfig`, `SelectConfig`, `ReplaceAppendConfig`, and `ExtractLodLevelConfig` for typed task construction. Existing `PipelineTask.config` remains `Record<string, unknown>`.

## Native builds

See [native build instructions](../splat-transform-native/source/README.md) for CMake presets, vcpkg, and platform requirements. Building the native program requires no Node or pnpm installation.

## Compatibility notes

- Format equivalence is checked after decompression/decoding; compression streams and ZIP metadata may differ between library versions.
- Migrated arithmetic uses float; LOD covariance, sampling, and edge-cost calculations retain double precision. Float rounding can affect quantization boundaries, so compare decoded values with the format's numerical tolerances.
- SOG clustering uses thread-local random engines seeded on first use. Successive exports can produce different clustering results.
- Large gzip and zstd payloads use bounded automatic parallel compression. The resulting files use standard gzip and zstd streams; decompressed data is unchanged.
- FlexLod now reads short score files correctly. The former JavaScript implementation could read unrelated bytes before a pooled Buffer's offset.
- Unpacked SOG metadata resolves local textures relative to meta.json. The former CLI did not correctly load this documented input form.
- Multi-section KSPLAT files append each section. The former reader overwrote earlier sections instead of advancing the output offset.

## License

[MIT License](./LICENSE). Third-party notices are included in THIRD_PARTY_LICENSES.txt and in each native platform package.
