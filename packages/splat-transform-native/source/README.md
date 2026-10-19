# Native splat-transform

Standalone C++20 processing engine for version 1 JSON pipelines. The executable accepts a pipeline filename or `-` for stdin. `--help` prints usage information and exits. `--version` prints the full package version, including prerelease suffixes, and exits. `--list-gpu` lists Vulkan adapters as JSON and exits before pipeline execution. Node is only needed for the npm CLI and JavaScript subprocess wrapper.

CLI11 generates help and validates command-line arguments. `-h` is an alias for `--help`. A pipeline input and `--list-gpu` are mutually exclusive; unknown options and invalid argument combinations print a diagnostic and help to stderr with exit code 2. Help and version requests exit with code 0, and pipeline/I/O failures use code 1. Use `--` before a filename that starts with `-`. Paths are treated as UTF-8, including on Windows; slash-prefixed Windows option syntax is disabled so paths starting with `/` remain positional arguments. CLI11 is supplied by vcpkg and linked only to the standalone executable.

## Build

Install CMake 3.31+, a C++20 compiler, and vcpkg. Set `VCPKG_ROOT` to the bootstrapped vcpkg checkout. Linux CI uses Ubuntu 22.04 and Clang 21 through `/usr/bin/cc` and `/usr/bin/c++`. Linux Clang builds also require the matching compiler-rt development package. Windows builds target Windows 10 or later (`_WIN32_WINNT=0x0A00`, `WINVER=0x0A00`). Windows presets let CMake select the generator and host architecture; use the preset matching the native build host, or pass cross-compilation settings explicitly. AppleClang builds enable `-fexperimental-library` for the logger translation unit because libc++ currently gates `<syncstream>` behind that flag.

CMake automatically generates missing or outdated shader headers during configuration. Install DXC using the [development setup](#dxc-and-shader-generation) below, or download matching CI shader headers to build without DXC. Run from this directory:

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

The main packages/splat-transform/package.json is the version source. CMake uses its numeric part for the project version and reconfigures when the manifest changes. configure_file generates build-directory generated/version.h from src/cli/version.h.in with the full version for native --version output. The npm CLI and publishing script also use the full version, including prerelease suffixes. Platform package manifests keep version 0.0.0 in source control; scripts/publish-packages.mjs assigns the main package version to them and the matching optional dependencies before publishing. Changing the main package manifest also triggers the native build workflow.

Vcpkg supplies static image/compression/archive/HTTP libraries, Eigen, nanoflann, nlohmann-json, Vulkan headers, and VMA. DXC is a separate development tool used only to generate shader headers. The native CMake build reuses matching headers without finding DXC and invokes the generator only when headers need regeneration. Vcpkg does not install or build DXC.

### DXC and shader generation

Shader generation requires CMake 3.31+ and a DXC build with SPIR-V support for the development host. CI uses Microsoft's [DXC v1.9.2609 release](https://github.com/microsoft/DirectXShaderCompiler/releases/tag/v1.9.2609); use that version where available to match CI.

| Platform                    | DXC setup                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64 / ARM64         | Extract `dxc_2026_09_29.zip` from the release. Add the matching `bin/x64` or `bin/arm64` directory to `PATH`, keeping the DLLs beside `dxc.exe`.                                                                                                                    |
| Linux x64                   | Extract `linux_dxc_2026_09_28.x86_x64.tar.gz` from the release. Add its `bin` directory to `PATH` and preserve the adjacent `lib` directory.                                                                                                                        |
| macOS                       | Install the [LunarG Vulkan SDK](https://vulkan.lunarg.com/doc/view/latest/mac/getting_started.html), then source its `setup-env.sh` or use `$VULKAN_SDK/bin/dxc` explicitly. The SDK includes a SPIR-V-enabled DXC; its version may differ from CI.                 |
| Linux ARM64 / source builds | Use a native DXC with SPIR-V support, or follow the [upstream Unix build instructions](https://github.com/microsoft/DirectXShaderCompiler/blob/main/docs/BuildingAndTestingDXC.rst) with `ENABLE_SPIRV_CODEGEN=ON`. The pinned release's Linux archive is x64-only. |

Check `dxc --version` and verify that it can compile with `-spirv`. A DXC bundled with another toolchain may omit the SPIR-V backend even when its help lists `-spirv`. Compilation, input hashing, variant enumeration, and header generation run directly through CMake; no Python or Node.js installation is needed.

Normal CMake configure and workflow commands generate the headers automatically when needed. Changes to `shaders/*.hlsl`, `shaders/*.hlsli`, `cmake/compile-shaders.cmake`, or `cmake/shader-inputs.cmake` also trigger reconfiguration and regeneration on the next build. To generate headers explicitly, run from this directory:

```sh
cmake -P cmake/compile-shaders.cmake
# Optional explicit compiler path; -D arguments must precede -P:
cmake -DDXC_EXECUTABLE=/path/to/dxc -P cmake/compile-shaders.cmake
# Generate for a different native build directory:
cmake -DSHADER_OUTPUT_DIR=build/arm64/generated/shaders -P cmake/compile-shaders.cmake
```

This CMake script runs independently of the native project: it does not configure C++, install vcpkg dependencies, or require a CMake build directory.

The CMake script also accepts `DXC_EXECUTABLE` as an environment variable and otherwise searches `PATH`. It resolves shader sources relative to the script, so it can be invoked from any working directory. Native configuration also accepts `-DDXC_EXECUTABLE=/path/to/dxc`; workflow presets can use `DXC_EXECUTABLE` from the environment.

Native builds write headers to `${CMAKE_CURRENT_BINARY_DIR}/generated/shaders`, so separate `cmake -B` directories have separate outputs. Standalone generation defaults to `source/build/generated/shaders`, matching the supplied presets. Override the output with `-DSHADER_OUTPUT_DIR=/path/to/generated/shaders` in either native configuration or the standalone CMake command. Relative output paths are resolved against the native binary directory during configuration, or against the working directory for standalone commands.

The generator compiles every `shaders/*.hlsl` entry point and the 24 clustering variants, producing 30 SPIR-V byte-array headers plus the aggregate `cluster.h` in the selected output directory. The source `shaders/` directory contains only HLSL inputs. Outputs under `build/` are covered by the existing Git ignore rule. Temporary files are staged inside the output directory and removed after generation; existing headers are replaced only after every shader compiles successfully. Unchanged headers retain their timestamps. Missing headers or an input checksum mismatch trigger automatic regeneration. If DXC is unavailable or compilation fails, configuration stops with a diagnostic and the previous headers remain intact.

CI runs `cmake -P packages/splat-transform-native/source/cmake/compile-shaders.cmake` once on Windows with the pinned, SHA-512-verified DXC archive. It uploads `source/build/generated/shaders/*.h` as the `native-shader-headers` artifact. Every Windows, Linux, and macOS native build job downloads it into `source/build/generated/shaders/`, matching the presets' binary directory. Matching artifacts skip generation and do not require DXC on those hosts. A developer can also extract the artifact from a successful workflow for the same source revision into their build directory's `generated/shaders/` folder. Subsequent shader changes require a local DXC for automatic regeneration or an updated matching artifact.

Shaders target Vulkan 1.1 / SPIR-V 1.3 with explicit descriptor bindings, push constants, and std430-compatible storage layouts. The build uses -fvk-use-gl-layout and does not require scalar-block-layout or subgroup extensions. HLSL clustering variants cover SH1/SH2/SH3 and all supported shared-memory tile sizes; runtime selection continues to respect each device's shared-memory limit. Linear kernels receive the dispatch width through push constants to preserve indexing across two-dimensional dispatches.

splat_transform_core is an OBJECT library shared by the executable and native tests. target_sources and header FILE_SETs declare its sources, public headers, private headers, and generated shader headers; source_group mirrors their directories in Visual Studio. Its object files, usage requirements, and link dependencies are consumed directly by those targets. Only the executable and dependency notices are installed into platform packages.

Vulkan-Hpp loads the user-provided Vulkan loader when a GPU task starts. GPU generation requires Vulkan 1.1+ and a compute-capable device; macOS also requires MoltenVK. No Vulkan loader, driver, Dawn module, or D3D compiler is shipped. CPU tasks run without Vulkan. Windows uses the static MSVC runtime. Linux Clang builds use LLVM compiler-rt builtins with GCC's unwinder; the build image includes `libclang-rt-21-dev` so libyuv's ARM64 SME kernels resolve their runtime helpers. When built with Clang, the Linux executable links compiler-rt, libstdc++, and the unwinder statically while retaining the Ubuntu 22.04 glibc baseline.

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

threading::default_pool() creates one process-wide pool on first access. LOD generation, cluster-center updates, bundle writers, SOG texture jobs, CPU voxel jobs, and parallel gzip blocks all reuse it. The default worker count preserves the previous LOD/clustering policy: half the next power of two of hardware_concurrency(), clamped to 1–16. Write.parallelCounts limits in-flight files and is capped by the pool's worker count.

Workers use std::jthread and stop-token-aware condition-variable waits. Stopping the pool discards queued tasks, makes their futures report broken promises, and joins running work. TaskGroup and ThreadPool::wait/get let waiting workers execute the same queue, so a full set of file writers can still complete nested gzip work. TaskGroup also waits for unfinished jobs during exception unwinding before borrowed input buffers or local state can be destroyed. Completed operations keep the pool alive for subsequent tasks.

gzip uses 1 MiB raw DEFLATE jobs with the preceding 32 KiB dictionary and combines them into one standard gzip member. zstd uses its native multithreaded compressor and one lazily created, process-wide ZSTD_threadPool shared through ZSTD_CCtx_refThreadPool. That static-library API accepts zstd's own pool type. It does not accept the C++ task executor. Each compression context remains independent; output remains a standard single zstd frame.

## Voxel backends

`Voxel.config.backend` accepts `"gpu"` (default) or `"cpu"`. The selection also controls cluster-filter voxelization and navigation dilation. A CPU-only pipeline does not initialize Vulkan, even when floor fill, exterior fill, or capsule navigation is enabled. Unknown backend names are rejected.

The internal `Backend` interface is the common adapter for voxel generation, dilation, backend names, and GPU requirements. `backend_cpu.cpp` and `backend_gpu.cpp` each contain their complete voxelization and dilation implementation; `backend.cpp` resolves the JSON option. The pipeline, cluster filter, and navigation call that interface. Shared geometry preparation, bounds, and filtering stay in `voxelize.cpp`.

CPU generation follows the historical TypeScript worker's 16 x 16 x 16 voxel batches, closest-point Gaussian evaluation, 1/255 contribution cutoff, and Beer-Lambert density accumulation. Small inputs use the same accumulated-density algorithm. CPU and GPU can differ at boundaries: GPU retains sub-threshold contributions and stops density accumulation at 7; CPU stops once the requested opacity is reached.

CPU candidate generation counts and scatters into one shared packed index buffer. Evaluation sorts each batch's indices into input order, dynamically assigns batches to the process-wide pool, and keeps density scratch local to each job. At most one job per pool worker is queued per phase; sparse output masks are merged after jobs finish. Geometry is shared with filtering without copying source colors or SH coefficients. The old per-task `cpuWorkerCount` option is not used.

## Layout and ownership

- include/splat and src/splat: canonical Gaussian/Splat storage, bounds, LOD generation, and block partitioning.
- include/io and src/io: IFile and concrete PLY, SPZ, SPLAT, SOG, ESZ, KSPLAT, LCC, and LCC2 readers/writers; format registration, ZIP resources, and HTTP assets.
- include/codec and src/codec: image and compression libraries. Large payloads use parallel zstd or gzip compression.
- include/spatial and src/spatial: clustering and SH transforms over native splats.
- include/gpu, src/gpu, and shaders: Vulkan-Hpp RAII objects, VMA buffers, GPU clustering, candidate generation, voxel evaluation, and dilation.
- include/pipeline and src/pipeline: BaseTask, concrete task implementations, task registration, and TaskContext resource ownership.
- include/voxel and src/voxel: CPU/GPU voxel generation, navigation topology, sparse octrees, and collision meshes.
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
