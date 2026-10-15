# Native splat-transform

Standalone C++20 processing engine for version 1 JSON pipelines. The executable accepts a pipeline filename or `-` for stdin. `--list-gpu` lists Vulkan adapters as JSON and exits before pipeline execution. Node is only needed for the npm CLI and JavaScript subprocess wrapper.

## Build

Install CMake 3.31+, a C++20 compiler, and vcpkg. Set `VCPKG_ROOT` to the bootstrapped vcpkg checkout. Linux CI uses Ubuntu 22.04 and Clang 21 through `/usr/bin/cc` and `/usr/bin/c++`. Windows presets let CMake select the generator and host architecture; use the preset matching the native build host, or pass cross-compilation settings explicitly. AppleClang builds enable `-fexperimental-library` for the logger translation unit because libc++ currently gates `<syncstream>` behind that flag.

Run from this directory:

```sh
cmake --workflow --preset x64-windows-static
cmake --workflow --preset arm64-windows-static
cmake --workflow --preset x64-linux
cmake --workflow --preset arm64-linux
cmake --workflow --preset arm64-osx
```

Choose the preset for the current platform. Each workflow configures, builds, installs, and runs CPU tests. Installation writes the executable and third-party notices into the corresponding sibling platform package. npm build scripts invoke CMake directly.

CI clones the vcpkg default branch with full history and runs its bootstrap script. Windows and macOS use a separate checkout at `${RUNNER_TEMP}/aholo-vcpkg`; the Linux build image uses `/opt/vcpkg`. Local builds should also use a full clone and set `VCPKG_ROOT` to that bootstrapped checkout.

The baseline in `vcpkg-configuration.json` selects dependency versions independently of the vcpkg checkout's HEAD. CI does not check out that commit. The Linux image includes the registry configuration in its cache key and passes its hash as `VCPKG_CACHE_KEY` to refresh the clone layer when the configuration changes. Cached images otherwise retain the vcpkg revision from their last build; use the `force-build-image` workflow input to refresh the entire image.

Linux presets explicitly use `/usr/bin/ninja`; macOS uses `/opt/homebrew/bin/ninja`, `/opt/homebrew/bin/nasm`, and the system C/C++ compilers.

After updating the baseline or changing the vcpkg checkout, configure with `cmake --fresh --preset x64-windows-static` (or the matching platform preset) before building. This clears cached dependency paths, including library names that can change between port versions.

The Linux CI image also retains Node.js 24 through fnm for the separate regression test suite. `NODE_VERSION` remains a build argument and participates in the image cache key. The native CMake build itself does not require Node.js.

Presets use build/ by default. Workflow mode takes the binary directory from its configure preset and does not accept a -B override. When Windows and WSLC share a source checkout, use a separate Linux directory through the configure command, then build and test that directory:

```sh
cmake --preset x64-linux -B build/x64-linux
cmake --build build/x64-linux --target install --parallel 8
ctest --test-dir build/x64-linux --output-on-failure
```

Run these commands inside the Ubuntu 22.04 build container. The preset still supplies the toolchain and installation destination. Normal CI jobs have separate workspaces and can use the workflow commands directly.

The main packages/splat-transform/package.json is the version source. CMake uses its numeric part for the project version and reconfigures when the manifest changes. The npm CLI and publishing script use the full version, including prerelease suffixes. Platform package manifests keep version 0.0.0 in source control; scripts/publish-packages.mjs assigns the main package version to them and the matching optional dependencies before publishing. Changing the main package manifest also triggers the native build workflow.

Vcpkg supplies static image/compression/archive/HTTP libraries, Eigen, nanoflann, nlohmann-json, Vulkan headers, VMA, and the DXC host compiler. HLSL compute shaders compile to embedded SPIR-V during the build. The local dxc overlay port pins DXC v1.8.2505.1 and its source dependencies. Windows x64/ARM64 and Linux x64 use Microsoft's release binaries; Linux ARM64 and macOS compile the same release from source. The optional dxc[from-source] feature also selects the source build on Linux x64. Only the build host needs DXC; runtime shader compilation and a Vulkan SDK are not required.

The DXC source overlay disables its legacy `StringRef` standard-trait specializations when using libc++, which already computes the correct traits and rejects those specializations with Apple Clang 21. Other standard libraries retain the existing workaround.

Shaders target Vulkan 1.1 / SPIR-V 1.3 with explicit descriptor bindings, push constants, and std430-compatible storage layouts. The build uses -fvk-use-gl-layout and does not require scalar-block-layout or subgroup extensions. HLSL clustering variants cover SH1/SH2/SH3 and all supported shared-memory tile sizes; runtime selection continues to respect each device's shared-memory limit. Linear kernels receive the dispatch width through push constants to preserve indexing across two-dimensional dispatches.

splat_transform_core is an OBJECT library shared by the executable and native tests. target_sources and header FILE_SETs declare its sources, public headers, private headers, and generated shader headers; source_group mirrors their directories in Visual Studio. Its object files, usage requirements, and link dependencies are consumed directly by those targets. Only the executable and dependency notices are installed into platform packages.

Vulkan-Hpp loads the user-provided Vulkan loader when a GPU task starts. GPU generation requires Vulkan 1.1+ and a compute-capable device; macOS also requires MoltenVK. No Vulkan loader, driver, Dawn module, or D3D compiler is shipped. CPU tasks run without Vulkan. Windows uses the static MSVC runtime; Linux links libstdc++ and libgcc statically while retaining the Ubuntu 22.04 glibc baseline.

## Numerical precision

Gaussian attributes and migrated pipeline, codec, SH rotation, clustering, and voxel arithmetic use float. Gaussian rotations use Eigen::Quaternionf and Eigen normalization. The LOD GaussianCache and its covariance, density, sampling, and edge-cost calculations retain double precision.

PLY float64 fields are read at their declared width before conversion. JSON index and RGBA validation checks the original number before narrowing; integer indices, packed fields, and counts retain integer storage. Quantization uses normalized values and float prefix sums. Compare outputs after decoding with the format's numerical tolerances.

utility::default_random() lazily initializes a thread-local std::mt19937 using std::random_device. Each thread seeds its engine once, then reuses it without shared state or locking. SOG centroid initialization and empty-cluster replacement use this entrypoint, so successive exports can produce different clustering results. LOD retains its existing fixed-seed Gaussian sampling and double precision.

## SOG scheduling and memory

SOG encoding overlaps SH clustering with CPU texture encoding. A clustering session reuses its Vulkan buffers, descriptor sets, and command buffers across iterations. Points that fit the budget stay on the device; the remaining points stream through at most two reusable slots. Centroids upload once per iteration. Batch sizes follow the available memory budget, storage-buffer capacity, and device workgroup-count limit, with at most two batches in flight.

The caller coordinates GPU clustering while independent texture preparation and WebP encoding jobs use the process-wide default CPU pool. SOG members are already compressed WebP images, so the outer ZIP uses STORE. Member generation runs in parallel; libzip assembles the final archive sequentially.

Clustering uses the full reported available device-local heap budget to cache as much input as fits. VK_EXT_memory_budget supplies the budget when available; otherwise VMA estimates it from the heap and its own allocations. Buffers are allocated only for the input data and required working storage. Input that fits the memory and device limits uses one batch. Allocation failures retry with a smaller budget, down to 32 MiB; insufficient memory produces an error. Host staging, driver allocations, and other GPU operations are outside the device-buffer accounting, so the process's measured GPU-memory peak can be higher.

Memory scheduling is automatic and preserves the existing pipeline JSON parameters. Pipeline JSON on stdin remains supported:

```powershell
Get-Content -Raw pipeline.json | ./splat-transform.exe -
```

## CPU task scheduling and compression

threading::default_pool() creates one process-wide pool on first access. LOD generation, cluster-center updates, bundle writers, SOG texture jobs, and parallel gzip blocks all reuse it. The default worker count preserves the previous LOD/clustering policy: half the next power of two of hardware_concurrency(), clamped to 1–16. Write.parallelCounts limits in-flight files and is capped by the pool's worker count.

Workers use std::jthread and stop-token-aware condition-variable waits. Stopping the pool discards queued tasks, makes their futures report broken promises, and joins running work. TaskGroup and ThreadPool::wait/get let waiting workers execute the same queue, so a full set of file writers can still complete nested gzip work. TaskGroup also waits for unfinished jobs during exception unwinding before borrowed input buffers or local state can be destroyed. Completed operations keep the pool alive for subsequent tasks.

gzip uses 1 MiB raw DEFLATE jobs with the preceding 32 KiB dictionary and combines them into one standard gzip member. zstd uses its native multithreaded compressor and one lazily created, process-wide ZSTD_threadPool shared through ZSTD_CCtx_refThreadPool. That static-library API accepts zstd's own pool type. It does not accept the C++ task executor. Each compression context remains independent; output remains a standard single zstd frame.

## Layout and ownership

- include/splat and src/splat: canonical Gaussian/Splat storage, bounds, LOD generation, and block partitioning.
- include/io and src/io: IFile and concrete PLY, SPZ, SPLAT, SOG, ESZ, KSPLAT, LCC, and LCC2 readers/writers; format registration, ZIP resources, and HTTP assets.
- include/codec and src/codec: image and compression libraries. Large payloads use parallel zstd or gzip compression.
- include/spatial and src/spatial: clustering and SH transforms over native splats.
- include/gpu, src/gpu, and shaders: Vulkan-Hpp RAII objects, VMA buffers, GPU clustering, candidate generation, voxel evaluation, and dilation.
- include/pipeline and src/pipeline: BaseTask, concrete task implementations, task registration, and TaskContext resource ownership.
- include/voxel and src/voxel: GPU voxel generation, navigation topology, sparse octrees, and collision meshes.
- include/utility and src/utility: shared thread pool and logger.

Namespaces use splat_transform with module namespaces; types use PascalCase, functions and variables use snake_case, constants use UPPER_SNAKE_CASE, and private fields use a trailing underscore. Formatting follows .clang-format. The check-format CMake target is available when clang-format is installed; .clang-tidy provides naming checks.

IFile defines reading and writing against Splat. Each format owns its decoding, encoding, and format options; the registry handles extensions and aliases. ZIP metadata selects a registered reader, and LCC2 child resources use the same interface. Read.maxShDegree limits SH allocation during decoding while preserving the source format's record layout. Unsupported writes fail through the format contract.

BaseTask defines execution and GPU requirements. The runner validates registered task names, executes tasks, and releases resources; each task implements its own behavior. TaskContext shares retained resources and aliases. A task that replaces or releases its sole input owner can move the Splat directly into LOD generation or selection. Existing version 1 pipeline fields and release behavior are preserved.

Gaussian is the canonical per-point record throughout reading, modification, LOD, voxel processing, and writing. It retains scale and rotation; covariance and point bounds are computed when used. SH coefficients keep RGB interleaved, with a variant of inline SH0 storage and unique_ptr-owned higher bands. SH rotation works directly on this storage. Clustering and GPU upload borrow native Gaussian records through span-based views; centroid and label matrices use Eigen row-major storage. Quantization borrows scalar attributes without allocating full-cloud columns. GPU upload and compressed formats use only their required working buffers.

## Logging

utility::Logger keeps the TypeScript CLI's task prefixes and message formats. Scoped prefixes and silence settings restore on return or exception. Timers use a monotonic clock and retain the task and encoding-stage labels. Each message snapshots the logger state under a mutex, then uses std::osyncstream to write and flush a complete line. Bundle writes suppress per-file encoding detail while reporting each output path and its sequence number.

Information, progress, and timing logs go to stdout; warnings and errors go to stderr. The Node wrapper inherits both streams during pipeline execution. The standalone --list-gpu command emits a JSON device array and returns from main before pipeline execution. Read counts, LOD targets/results, per-level counts, and bundle progress are calculated from the actual resources and output layout. Production code does not expose profiling switches, memory-budget overrides, or test-only scheduler inspection.

## Validation

```sh
ctest --preset x64-windows-static
cmake --preset x64-windows-static -DSPLAT_TRANSFORM_TEST_GPU=ON
cmake --build --preset x64-windows-static
ctest --preset x64-windows-static
```

GPU tests are opt-in and require a working Vulkan device. Run splat_transform_gpu_tests --large separately to exercise candidate generation and dilation across the 65535-workgroup X boundary; it requires additional host and device memory. Default CI tests cover formats, task contracts, compression, CPU topology, concurrent first pool access, nested scheduling, task lifetime during exceptions, and all 30 embedded shader modules' storage strides, member offsets, push constants, and shared-memory sizes without initializing Vulkan. Linux also checks that required GLIBC versions do not exceed 2.35 and that the executable has no dynamic libstdc++, libgcc, or Vulkan loader dependency.

CLI regression checks live in the separate [splat-transform-test-suite](https://github.com/manycoretech/splat-transform-test-suite) repository. Its verifier compares the 1.x log format, generated LOD metadata, and output files. The npm wrapper package contains no tests or benchmark harnesses.
