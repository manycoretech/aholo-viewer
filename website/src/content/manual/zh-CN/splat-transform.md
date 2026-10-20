---
title: splat-transform
description: splat-transform 使用指南、任务参数与输出格式。
order: 5
---

## 背景

`splat-transform` 是面向 Aholo Viewer 的 3DGS 处理工具，用于格式转换、数据选择与修改、LOD 生成和体素碰撞体生成。npm CLI 将命令转换为 JSON pipeline，再交给独立 C++ 进程执行。

## 环境需求

- npm CLI 和 JavaScript 接口需要 Node.js >= 22.22.1；独立可执行文件无需 Node.js。
- Windows：Windows 22H2+，x86_64 或 ARM64。
- Linux：x86_64 或 ARM64，Ubuntu 22.04 / glibc >= 2.35；C++ 运行库静态链接。
- macOS：macOS 13+，苹果芯片 ARM64。
- GPU 加速需要 Vulkan 1.1+ loader 和兼容驱动；macOS 还需要 MoltenVK。安装包不携带 Vulkan 运行时或驱动。

含 SH 系数的 SOG 输出使用 GPU 聚类；SH0 SOG 编码可在 CPU 上执行。其他格式转换和 LOD 处理无需 Vulkan。Voxel 的后端和回退规则见 [Voxel](#voxel)。

运行 `splat-transform list:gpu` 查询 Vulkan 设备。旧版 Dawn 枚举可能包含 D3D12 设备，迁移时应重新确认 GPU 下标。

## 格式说明

### 输入格式

| 格式                    | 说明                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `ply`、`compressed.ply` | 标准 PLY 和 SuperSplat 压缩 PLY。                                  |
| `splat`、`ksplat`       | SPLAT 和 KSPLAT；KSPLAT 可包含多个 section。                       |
| `spz`、`uspz`           | SPZ 和未 gzip 压缩的 SPZ。                                         |
| `sog`、`meta.json`      | SOG 压缩包或未打包的 SOG 元数据。                                  |
| `esz`                   | ESZ v2，支持低精度和高精度布局。                                   |
| `lcc`、`lcc2`           | 传入元数据文件；LCC2 读取 LOD0 和环境高斯。                        |
| `zip`                   | 包含 LCC、LCC2 或 SOG 资源的 ZIP，不是任意高斯文件的通用批量输入。 |

未打包 SOG/LCC/LCC2 的伴随资源相对于元数据文件解析；ZIP 内的资源相对于包内元数据路径解析，支持嵌套目录。普通 pipeline 输入输出路径相对于进程工作目录。

### 输出格式

| 格式           | 说明                                                                |
| -------------- | ------------------------------------------------------------------- |
| `ply`、`splat` | 标准 PLY 和 SPLAT。                                                 |
| `spz`、`uspz`  | SPZ v3/v4，以及未 gzip 压缩的 SPZ v3；版本由 [Write](#write) 配置。 |
| `sog`          | SOG；有 SH 系数时需要 GPU。                                         |
| `esz`          | ESZ v2；`highPrecision` 控制精度。推荐用于分块 LOD。                |
| LOD / 分块目录 | 由 `AutoChunkLod` 或 `SplitSplatTask` 生成，再由 `Write` 写出。     |
| 体素目录       | 由 `Voxel` 直接写出元数据、体素二进制及可选碰撞 GLB。               |

## 安装与命令行

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

| 命令             | 对应任务与参数                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `create`         | `Read → Modify → Write`，用于格式转换。                                        |
| `lod:loading`    | `SkeletonLod`；可选 `--ratio`。                                                |
| `lod:flex`       | `FlexLod`；必填 `--score`，可选 `--ratio`。                                    |
| `lod:auto`       | `AutoLod`；可选 `--ratio`、`--split-normal`。                                  |
| `lod:auto-chunk` | `AutoChunkLod`；必填 `--type`，可选 `--max-chunk-counts`、`--split-normal`。   |
| `split`          | `SplitSplatTask`；必填 `--type`，可选 `--max-chunk-counts`、`--split-normal`。 |
| `list:gpu`       | 列出 Vulkan 设备下标和名称。                                                   |

`--type` / `-t` 接受 `ply`、`spz`、`splat`、`sog`、`esz`。`--split-normal` 接受 `None`、`X`、`Y`、`Z`，不区分大小写，或对应数字 `0`、`1`、`2`、`3`。指定参考轴可使分块沿该轴保持完整，例如 `Y` 用于保留竖直方向。复杂参数使用 pipeline 配置；单个命令的帮助可通过 `splat-transform lod:flex --help` 等方式查看。

npm CLI 和独立可执行文件都接受 pipeline 文件或 `-` 标准输入。独立可执行文件只提供 pipeline、`--list-gpu`、`--help` 和 `--version` 入口，上述命令别名由 npm CLI 提供。

```powershell
Get-Content -Raw pipeline.json | splat-transform -
```

## Pipeline 描述与资源生命周期

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

| 字段              | 类型 / 默认值     | 说明                                                                          |
| ----------------- | ----------------- | ----------------------------------------------------------------------------- |
| `version`         | `1`               | pipeline 版本，与 SPZ 输出版本无关。                                          |
| `gpu`             | `number` / `0`    | `list:gpu` 或 `enumerateAdapters()` 返回的设备下标；实际 GPU 工作开始时使用。 |
| `tasks`           | `PipelineTask[]`  | 按数组顺序执行；任务失败时终止后续任务。                                      |
| `tasks[].id`      | `string`          | 任务日志标识，TypeScript 接口要求提供。                                       |
| `tasks[].type`    | `string`          | 下文列出的任务名称，区分大小写。                                              |
| `tasks[].config`  | `object`          | 对应任务的参数。                                                              |
| `tasks[].release` | `string[]` / `[]` | 当前任务成功完成后删除这些内存资源键。                                        |

`Read.output` 和处理任务的 `input` / `output` 是本次运行的内存资源键；`Read.inputs`、`Write.output`、`Voxel.output` 才是磁盘路径。相对路径以进程工作目录为基准，不以 pipeline 文件所在目录为基准。

同名 `output` 会替换原资源键。`Modify` 原地修改输入，即使使用不同的 `output`，两者仍指向同一资源。需要保留原数据时，先用 `Select` 或 `ExtractLodLevel` 创建独立副本。`Write` 只读内存资源，但会写入或替换磁盘文件；多次写出应在最后一次使用后再 `release`。不要在任务的 `release` 中删除后续仍要使用的输出键。

日志、进度和计时输出到 stdout，警告和错误输出到 stderr。独立可执行文件成功退出为 `0`，pipeline/I/O 失败为 `1`，命令行参数错误为 `2`。失败不回滚此前已完成的磁盘输出。

## 任务参考

除 `Read`、`Write`、`Voxel` 的路径字段外，各任务的 `input` 和 `output` 均为必填内存资源键。

### Read

读取多个输入并合并，保留输入块顺序供 `Modify.modifyPaths` 使用。

| 参数          | 类型 / 默认值            | 说明                                            |
| ------------- | ------------------------ | ----------------------------------------------- |
| `inputs`      | `string[]`，必填         | 输入文件路径。                                  |
| `output`      | `string`，必填           | 输出资源键。                                    |
| `maxShDegree` | `0 \| 1 \| 2 \| 3` / `3` | 最多保留的 SH 阶数；不会生成输入中不存在的 SH。 |

### Write

将单个 splat 写入文件，或将 LOD / 分块 bundle 写入目录。格式由输出文件扩展名或 bundle 中的文件名决定。

| 参数               | 类型 / 默认值                           | 说明                                                                                         |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `input`            | `string`，必填                          | 输入资源键。                                                                                 |
| `output`           | `string`，必填                          | 单文件路径或 bundle 输出目录。                                                               |
| `enableMortonSort` | `boolean` / `true`                      | 写出前按 Morton 顺序排列；要求保留区间顺序的 bundle 文件会强制关闭。                         |
| `version`          | `3 \| 4` / `3`                          | 仅用于 `.spz`；`.uspz` 固定输出未压缩的 v3。                                                 |
| `compressLevel`    | `number`                                | SPZ v3 使用 gzip，默认 `6`，常用范围 `0–9`；SPZ v4 使用 zstd，默认 `7`，遵循 zstd 等级范围。 |
| `highPrecision`    | `boolean` / `false`                     | 仅用于 ESZ：`false` 为低精度，`true` 为高精度布局。                                          |
| `parallelCounts`   | `number` / `max(1, CPU 硬件线程数 − 1)` | bundle 同时写出的文件数上限，实际并发还受共享 CPU 线程池限制。                               |

**目录覆盖：写出 bundle 时，已有输出目录会先被递归删除，再重新创建。请使用专用输出目录。** 根目录和当前工作目录会被拒绝。单文件输出会覆盖同名文件。

同一 LOD bundle 可以分别以 `highPrecision: false` 和 `true` 写到两个目录。写出不会消费或修改内存数据，也不会破坏 LOD 的 file/offset/count 区间。

### Modify

| 参数              | 类型 / 默认值                               | 说明                                                               |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `input`、`output` | `string`，必填                              | 输入及输出资源键；输出是修改后输入的别名。                         |
| `modifyPaths`     | `string[]` / `[]`                           | 按输入块顺序应用 patch JSON；空字符串跳过该块。                    |
| `rgba`            | `[number, number, number, number]` / 不修改 | 内部 RGBA 浮点值，必须有限且可存入 float；不钳制、不转换色彩空间。 |
| `maxShDegree`     | `0 \| 1 \| 2 \| 3` / 不截断                 | 截断到当前阶数与指定阶数的较小值。                                 |

先验证 `rgba` / `maxShDegree`，再应用 patch 变换和删除，最后设置剩余点的 RGBA、截断 SH。patch 格式如下：

```typescript
interface ModifyPatch {
    isRowMatrix?: boolean; // 默认 true；矩阵为 16 个数
    transform?: number[]; // 整个输入块的变换，默认单位矩阵
    deletedIndices?: number[]; // 字节位图，第 i 个点对应 byte[i >> 3] 的第 (i & 7) 位
    indicesTransform?: Array<{ indices: number[]; transform: number[] }>;
}
```

patch 中的索引相对于对应输入块。`deletedIndices` 是位图，不是待删除点的索引列表。

### Select

| 参数              | 类型           | 说明                                                                                         |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `input`、`output` | `string`，必填 | 复制为独立的单块 splat 资源。                                                                |
| `indices`         | `number[]`     | 与 `indicesPath` 恰好二选一。                                                                |
| `indicesPath`     | `string`       | `.json` 支持数组或 `{ "indices": [...] }`；其他文件按小端 uint32 读取，`.zst` 先 zstd 解压。 |

按首次出现顺序稳定去重，例如 `[8,2,8,5] → [8,2,5]`，复制完整属性和 SH，不做 Morton 排序。索引必须是有效整数；二进制长度必须为 4 的倍数。空索引有效，空结果能否写出取决于目标格式。

### ReplaceAppend

| 参数                       | 类型             | 说明                               |
| -------------------------- | ---------------- | ---------------------------------- |
| `input`、`patch`、`output` | `string`，必填   | 原始资源、补丁资源和独立输出资源。 |
| `sourceIndices`            | `number[]`，必填 | 不重复的源索引，可以为空。         |

令源点数为 N、patch 点数为 M、索引数为 K：patch 前 K 点依次替换对应源点，其余追加，结果点数为 N+M−K，要求 K≤M。源和 patch 的 SH 阶数、属性布局必须一致；输入及其别名不被修改。

### ExtractLodLevel

| 参数              | 类型           | 说明                                                      |
| ----------------- | -------------- | --------------------------------------------------------- |
| `input`、`output` | `string`，必填 | 当前 pipeline 中的 LOD bundle 和独立输出资源。            |
| `level`           | `number`，必填 | 从 `0` 开始的层级，必须小于 bundle 的层数，没有默认层级。 |

按 `tree` 顺序复制指定层的 file/offset/count 区间，保留重复引用，复制完整属性和独立 SH 存储。此任务不会从磁盘 `lod-meta.json` 恢复 bundle，也不会重新生成 LOD。

### SkeletonLod

生成用于加载预览的粗略 SH0 数据。

| 参数              | 类型 / 默认值      | 说明               |
| ----------------- | ------------------ | ------------------ |
| `input`、`output` | `string`，必填     | 输入及输出资源键。 |
| `ratio`           | `number` / `0.1`   | 目标保留比例。     |
| `counts`          | `number` / `85000` | 目标保留数量上限。 |

目标点数为 `min(ceil(输入点数 × ratio), counts)`。实际输出可能更少。对应 CLI 为 `lod:loading`。

### FlexLod

按外部评分选点，保留原始点属性。

| 参数              | 类型 / 默认值     | 说明                                                       |
| ----------------- | ----------------- | ---------------------------------------------------------- |
| `input`、`output` | `string`，必填    | 输入及输出资源键。                                         |
| `scorePath`       | `string`，必填    | 小端 float32 二进制文件，按输入点顺序提供至少一个评分/点。 |
| `ratio`           | `number` / `0.3`  | 目标保留比例。                                             |
| `counts`          | `number` / 不限制 | 与比例共同限制目标数量。                                   |
| `originalIndices` | `string` / 不写出 | 可选输出路径，保存保留点的原始索引，小端 uint32。          |

选择评分最高的 `min(ceil(输入点数 × ratio), counts)` 个点，评分相同时保持原顺序，最终结果按原始索引升序排列。对应 CLI 为 `lod:flex --score scores.bin`。

### AutoLod

融合高斯生成简化结果。

| 参数              | 类型 / 默认值                      | 说明                             |
| ----------------- | ---------------------------------- | -------------------------------- |
| `input`、`output` | `string`，必填                     | 输入及输出资源键。               |
| `ratio`           | `number` / `0.3`                   | 目标保留比例，通常为 `0–1`。     |
| `counts`          | `number` / 不限制                  | 与比例共同限制目标数量。         |
| `splitNormal`     | `None/X/Y/Z` 或 `0/1/2/3` / `None` | 分块参考轴；字符串不区分大小写。 |

目标点数为 `min(ceil(输入点数 × ratio), counts)`。小块停止条件和迭代上限可能使实际点数高于目标。对应 CLI 为 `lod:auto`。

### AutoChunkLod

生成含 `lod-meta.json` 的多级分块 bundle，随后使用 `Write` 写出。运行时接入见 [Chunk LOD](./chunk-lod.md)。

| 参数              | 类型 / 默认值                      | 说明                                                         |
| ----------------- | ---------------------------------- | ------------------------------------------------------------ |
| `input`、`output` | `string`，必填                     | 输入及 bundle 输出资源键。                                   |
| `type`            | `string`，必填                     | chunk 文件格式，推荐 `esz`。                                 |
| `maxChunkCounts`  | `number` / `400000`                | 控制初始分块点数规模，必须大于 0；合并后的层级文件可能更大。 |
| `splitNormal`     | `None/X/Y/Z` 或 `0/1/2/3` / `None` | 分块参考轴。                                                 |
| `levels`          | `ChunkLevel[]` / 下列配置          | 自定义数组会替换整个默认数组。                               |

```json
[
    { "precision": 1.0, "scaleBoost": 1 },
    { "precision": 0.5, "scaleBoost": 1 },
    { "precision": 0.25, "scaleBoost": 1 },
    { "precision": 0.05, "scaleBoost": 1.01, "merged": true, "permanent": true },
    { "precision": 0.01, "scaleBoost": 1.02, "merged": true, "permanent": true }
]
```

| 层级字段     | 默认值  | 说明                                                                          |
| ------------ | ------- | ----------------------------------------------------------------------------- |
| `precision`  | 必填    | 相对于原始数据的目标保留比例；第 0 级保留原始数据，应设为 `1`，后续逐级降低。 |
| `scaleBoost` | `1`     | 简化后高斯尺度放大系数，用于缓解低精度层级的空洞。                            |
| `merged`     | `false` | 将该级尚未安排输出的分块合并为文件，并保留区间顺序。                          |
| `permanent`  | `false` | 将该级引用的文件加入 `permanentFiles`，供运行时常驻加载。                     |

自定义 `levels` 时，省略 `merged` / `permanent` 表示 `false`；不会继承默认数组最后两级的 `true`。同一 pipeline 对同源数据生成 Voxel 后，LOD 元数据会自动写入相对 `voxels` 路径，支持 Voxel 在 LOD 写出前或后执行。

### SplitSplatTask

仅分块，不生成多级 LOD，也不生成 `lod-meta.json`。输出 bundle 包含 `block_0.<type>` 等文件，由 `Write` 写入目录。

| 参数              | 类型 / 默认值                      | 说明                           |
| ----------------- | ---------------------------------- | ------------------------------ |
| `input`、`output` | `string`，必填                     | 输入及 bundle 输出资源键。     |
| `type`            | `string`，必填                     | 分块文件格式，推荐 `esz`。     |
| `maxChunkCounts`  | `number` / `400000`                | 控制分块点数规模，必须大于 0。 |
| `splitNormal`     | `None/X/Y/Z` 或 `0/1/2/3` / `None` | 分块参考轴。                   |

### Voxel

从 splat 资源直接生成体素目录，无需后续 `Write`。文件格式见 [物理碰撞](./physics-collision.md)。

| 参数                | 类型 / 默认值                                | 说明                                                                                        |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `input`             | `string`，必填                               | 输入 splat 资源键。                                                                         |
| `output`            | `string`，必填                               | 体素输出目录。                                                                              |
| `voxelResolution`   | `number` / `0.05`                            | 体素边长，必须为有限正数，与输入坐标使用相同单位。                                          |
| `opacityCutoff`     | `number` / `0.1`                             | 占用阈值，范围 `0–1`；提高可剔除更多低密度区域。                                            |
| `backend`           | `gpu \| cpu` / `gpu`                         | 计算后端，回退规则见下文。                                                                  |
| `box`               | `{ minCorner: [x,y,z], maxCorner: [x,y,z] }` | 默认 `[-100,-100,-100]` 到 `[100,100,100]`，限制生成范围。                                  |
| `filterCluster`     | `boolean \| object` / `true`                 | 预先筛选主要连通区域；`false` 禁用，对象参数见下表。                                        |
| `autoDenseBox`      | `boolean \| object` / `true`                 | 尺度离群值导致范围膨胀时，尝试收紧生成范围。                                                |
| `compression`       | `none \| gzip \| zstd` / `none`              | 二进制压缩方式，对应 `.bin`、`.bin.gz`、`.bin.zst`。                                        |
| `nodeEncoding`      | `raw \| compact` / `raw`                     | 八叉树节点编码；compact 需要先解码为运行时节点布局。                                        |
| `collisionMesh`     | `boolean \| smooth \| faces` / `false`       | `true` 等同 `smooth`；`faces` 输出体素表面，`smooth` 使用 marching cubes 并合并共面三角形。 |
| `floorFill`         | `boolean` / `false`                          | 从网格底部向上填充至地面。                                                                  |
| `floorFillDilation` | `number` / `0`                               | 地面填充的水平膨胀距离，非负，与 `floorFill` 配合。                                         |
| `navExteriorRadius` | `number` / `0`                               | 外部填充的膨胀距离，非负；需要 `navSeed`。                                                  |
| `navSeed`           | `{ x, y, z }` / 不设置                       | 场景坐标中的导航种子点，供外部填充与胶囊体导航使用。                                        |
| `navCapsule`        | `{ height, radius }` / 不设置                | 胶囊体导航尺寸；`height > 0` 且设置 `navSeed` 时启用，`radius` 非负。                       |

默认优先使用 GPU。每个 Voxel 任务在获取后端时初始化所选 Vulkan 设备；初始化失败则记录警告并返回 CPU 后端，随后聚类过滤、主生成和导航均使用 CPU。设置 `backend: "cpu"` 时不尝试初始化 Vulkan。后端一旦选定，计算过程中不再切换；GPU 计算错误直接返回，空结果也不会触发 CPU 重算。参数、文件无效及 CPU 处理失败仍会报错。线程数由进程级共享线程池管理，旧 `cpuWorkerCount` 不再生效。

`filterCluster` 对象参数：

| 字段              | 默认值                 | 说明                                                                                           |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `voxelResolution` | `1`                    | 预过滤网格的体素边长。                                                                         |
| `opacityCutoff`   | `0.999`                | 预过滤占用阈值。                                                                               |
| `minContribution` | `0.1`                  | 高斯对所选连通区域的最小贡献阈值。                                                             |
| `seed`            | `{ x: 0, y: 0, z: 0 }` | 连通区域种子点。未显式设置且保留点数过少时，自动尝试其他较大的连通区域；显式种子不触发该搜索。 |

`autoDenseBox` 对象参数：

| 字段                     | 默认值 | 说明                                             |
| ------------------------ | ------ | ------------------------------------------------ |
| `targetCenterKeepRatio`  | `0.98` | 估计密集范围时的目标中心点保留比例。             |
| `minimumCenterKeepRatio` | `0.95` | 收紧范围至少应保留的中心点比例，否则保留原范围。 |
| `minimumAxisInflation`   | `1.5`  | 高斯范围相对于中心点范围的轴向膨胀阈值。         |
| `minimumVolumeInflation` | `4`    | 对应体积膨胀阈值；任一膨胀阈值达到时才尝试收紧。 |

网格或八叉树索引超出容量时，生成器可能自动增大体素边长后重试；实际尺寸以 `voxel-meta.json.voxelResolution` 为准。`Voxel` 创建目录并覆盖同名输出，但不会清空整个目录；切换压缩方式后应按元数据 `files` 加载当前文件。没有生成三角形时不会写出 `collision.glb`。

## Pipeline 示例

### 合并与修改

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

### 共享 LOD、交互数据与体素

先保留源数据，再创建 LOD bundle。提取第 3 级后仅修改其副本；低精度和高精度 LOD 共用同一 bundle。最后生成体素，两个 LOD 目录的元数据都会关联该体素输出。

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

### 选择与替换

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

该示例要求输入至少包含一个点。`ReplaceAppend` 不接受 SH 阶数不同的补丁，因此修改补丁时没有截断 SH。

## JavaScript 接口

```javascript
import { run, PipelineError } from '@manycore/aholo-splat-transform';

const controller = new AbortController();
// 由调用方在需要取消时执行 controller.abort()。
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

`run()` 返回 `Promise<void>`。`enumerateAdapters({ cwd, signal })` 返回 Vulkan 设备数组，包含 `index`、`name`、`backend: "vulkan"`、`vendorId`、`deviceId`、`apiVersion` 和 `uuid`；枚举本身需要 Vulkan。

`PipelineError` 表示子进程以非零状态或信号退出；启动失败和 `AbortSignal` 取消也可能以普通 Error / AbortError 拒绝。SIGINT、SIGTERM 会转发给子进程。可使用 `resolveExecutable()` 查询原生程序路径，或通过 `SPLAT_TRANSFORM_EXECUTABLE` 指定本地可执行文件的绝对路径。安装缺少平台程序时，确认 npm optional dependencies 未被禁用。

包导出 `PipelineConfig`、`PipelineTask`、`TaskType`、`RunOptions`、`VulkanAdapter`，以及 `ModifyConfig`、`SelectConfig`、`ReplaceAppendConfig`、`ExtractLodLevelConfig`、`VoxelConfig`。`PipelineTask.config` 仍为 `Record<string, unknown>`，完整参数以上文为准。

## 迁移与资源建议

2.0 移除了 `SplatData`、`injectCustomTask`、深层模块导入等内存处理接口。数据保留在原生子进程中，通过 CLI、version 1 pipeline 和 `run()` 使用。

- 生成 `chunk-lod` 推荐使用 `esz`：pipeline 设置 `type: "esz"`，CLI 使用 `--type esz`。
- SOG 聚类按可用 Vulkan 显存和设备限制自动分批，数据可分批传输，不存在统一的 10 GB 显存门槛；不足以容纳工作缓冲时仍会报错。相同数据多次 SOG 导出可能因随机聚类而不同。
- 大场景 LOD 和体素处理需要足够的系统内存。及时 `release` 不再使用的资源，限制 bundle 的写出并发，并按场景调整分块规模和体素尺寸。
- CPU 和 GPU 体素在阈值附近可能产生不同占用结果。设备初始化失败时选择 CPU，可在没有可用 GPU 的环境中继续生成，但不保证两种后端逐位一致。
