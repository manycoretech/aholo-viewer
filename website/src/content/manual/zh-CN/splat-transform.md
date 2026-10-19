---
title: splat-transform
description: splat-transform使用指南
order: 5
---

## 背景

`splat-transform`是面向 Aholo Viewer 的 3DGS 处理工具，用于格式转换、数据简化、LOD 生成和体素碰撞体生成。

## 环境需求

- npm CLI 和 JavaScript 接口需要 Node.js >= 22.22.1；独立 C++ 可执行文件无需 Node.js。
- Windows: Windows 22H2+，x86_64 或 ARM64。
- Linux: x86_64 或 ARM64，Ubuntu 22.04 / glibc >= 2.35；C++ 运行库静态链接。
- macOS: macOS 13+，苹果芯片 ARM64。
- GPU 功能需要用户安装 Vulkan 1.1+ loader 和兼容驱动；macOS 还需要可用的 MoltenVK。安装包不携带 Vulkan 运行时。

### 需要GPU的功能

- 含 SH 系数的 SOG 生成；SH0 SOG 可在 CPU 上编码。
- Voxel 使用默认的 `backend: "gpu"` 时需要 Vulkan。设置 `backend: "cpu"` 后，体素生成、聚类过滤和导航膨胀均在 CPU 上执行，无需 Vulkan。

不使用 GPU 的格式转换和 LOD 处理无需 Vulkan。使用 `splat-transform list:gpu` 查询当前 Vulkan 设备；旧版 Dawn 枚举可能包含 D3D12 设备，原有 GPU 下标需要重新确认。

## 格式说明

### 输入格式

- `ply`
- `sog`
- `ksplat`
- `splat`
- `spz`
- `lcc`
- `lcc2`
- `esz`
- `compressed.ply`，即 supersplat 压缩 ply
- `meta.json`，即 sog 未打包 meta 数据

### 输出格式

- `ply`
- `spz`
- `uspz`，即未 gzip 的 spz
- `splat`
- `sog`
- `esz`

### modify格式说明

```javascript
{
    isRowMatrix: boolean; // 确认行矩阵或列矩阵，默认为 true
    transform: number[]; // model级别的变换
    deletedIndices: number[]; // 删除的下标，bitmap形式
    indicesTransform: Array<{ indices: number[]; transform: number[] }>; // 局部变换的列表
}
```

## 使用方式

### 如何安装

```bash
npm install @manycore/aholo-splat-transform -g
```

### CLI 模式

```bash
splat-transform create <input> <output> # 转换3DGS格式
splat-transform lod:auto --ratio <ratio> <input> <output> # 简化3DGS到指定比例 ratio [0-1]
splat-transform lod:auto-chunk --type <type:ply,spz,splat,sog,esz> --max-chunk-counts <count> <input> <output> # 生成可以被调度的多级别lod数据，--max-chunk-counts 最大分块大小
```

### pipeline 模式(推荐)

```bash
splat-transform pipeline.json
```

独立可执行文件也接受 `pipeline.json`，或通过 `-` 从标准输入读取 JSON。Node CLI 负责把 `create`、`lod:auto` 等命令转换为相同的 pipeline。pipeline 中的输入输出路径相对于进程工作目录，SOG/LCC/LCC2 的资源路径相对于元数据文件。

2.0 版本移除了 `SplatData`、自定义任务注入和内部模块导入等内存处理接口。JavaScript 接口保留 `run(config, { cwd, signal })` 和 `enumerateAdapters()`，实际处理在子进程中完成。

#### pipeline 描述文件(`pipeline.json`)

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
        <th>名称</th>
        <th>功能</th>
        <th>参数</th>
        <th>类型</th>
        <th>必须(默认值)</th>
        <th>说明</th>
    </tr>
    <tr>
        <td rowspan="3">Read</td>
        <td rowspan="3">读取多个高斯文件并且合并成一个SplatData对象</td>
        <td>inputs</td>
        <td>string[]</td>
        <td>Y</td>
        <td>输入的文件路径</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>写入资源key</td>
    </tr>
        <tr>
        <td>maxShDegree</td>
        <td>number<br/>0..=3</td>
        <td>N(3)</td>
        <td>最大球协阶数</td>
    </tr>
    <tr>
        <td rowspan="4">Write</td>
        <td rowspan="4">将SplatData对象按指定格式存储到磁盘</td>
        <td>input</td>
        <td>string</td>
        <td>Y</td>
        <td>读取资源key</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>写出资源路径</td>
    </tr>
    <tr>
        <td>compressLevel</td>
        <td>number<br/>0..=9</td>
        <td>N(6)</td>
        <td>gzip压缩level</td>
    </tr>
    <tr>
        <td>enableMortonSort</td>
        <td>boolean</td>
        <td>N(true)</td>
        <td>开启莫顿排序</td>
    </tr>
    <tr>
        <td rowspan="5">Modify</td>
        <td rowspan="5">原地修改内存 splat 资源</td>
        <td>input</td>
        <td>string</td>
        <td>Y</td>
        <td>读取资源key</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>写入资源key</td>
    </tr>
    <tr>
        <td>modifyPaths</td>
        <td>string[]</td>
        <td>N([])</td>
        <td>modify json 文件路径<br />格式参考<a href="#modify格式说明">modify格式说明</a></td>
    </tr>
    <tr>
        <td>rgba</td>
        <td>[number, number, number, number]</td>
        <td>N(不修改)</td>
        <td>内部 RGBA 值；必须有限且可存入 float，不钳制、不转换色彩空间</td>
    </tr>
    <tr>
        <td>maxShDegree</td>
        <td>0 | 1 | 2 | 3</td>
        <td>N(不截断)</td>
        <td>截断到 min(当前阶数, 指定阶数)，不生成高阶 SH</td>
    </tr>
    <tr>
        <td rowspan="4">AutoLod</td>
        <td rowspan="4">生成融合高斯结果</td>
        <td>input</td>
        <td>string</td>
        <td>Y</td>
        <td>读取资源key</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>写入资源key</td>
    </tr>
    <tr>
        <td>counts</td>
        <td>number</td>
        <td>N(Infinity)</td>
        <td>最大保留数量</td>
    </tr>
    <tr>
        <td>ratio</td>
        <td>number<br/>0..=1</td>
        <td>N(0.3)</td>
        <td>最大保留比例</td>
    </tr>
    <tr>
        <td rowspan="6">AutoChunkLod</td>
        <td rowspan="6">生成分块融合高斯结果，使用需要结合lod调度模块</td>
        <td>input</td>
        <td>string</td>
        <td>Y</td>
        <td>读取资源key</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>写入资源key</td>
    </tr>
    <tr>
        <td>type</td>
        <td>string</td>
        <td>Y</td>
        <td>chunk的文件类型，参考<a href="#输出格式">输出格式</a></td>
    </tr>
    <tr>
        <td>forceSpzFormatThreshold</td>
        <td>number</td>
        <td>N(0)</td>
        <td>目前由于数量少的场景下sog的压缩率很差，所以增加了这个参数，低于这个参数的chunk会强制转换成spz格式，建议实际中设置 200000</td>
    </tr>
    <tr>
        <td>maxChunkCounts</td>
        <td>number</td>
        <td>N(400000)</td>
        <td>chunk的最大高斯点数量</td>
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
        <td>chunk的最大高斯点数量</td>
    </tr>
    <tr>
        <td rowspan="8">Voxel</td>
        <td rowspan="8">生成体素碰撞体</td>
        <td>input</td>
        <td>string</td>
        <td>Y</td>
        <td>读取资源key</td>
    </tr>
    <tr>
        <td>output</td>
        <td>string</td>
        <td>Y</td>
        <td>输出文件路径</td>
    </tr>
    <tr>
        <td>voxelResolution</td>
        <td>number</td>
        <td>N(0.05)</td>
        <td>体素尺寸</td>
    </tr>
    <tr>
        <td>opacityCutoff</td>
        <td>number</td>
        <td>N(0.1)</td>
        <td>体素筛选阈值，值越高体素越容易被剔除，漂浮物多的方案可以适当提高此值</td>
    </tr>
    <tr>
        <td>backend</td>
        <td>
            string
            <ul>
                <li>gpu</li>
                <li>cpu</li>
            </ul>
        </td>
        <td>N(gpu)</td>
        <td>默认使用 Vulkan GPU，GPU 错误直接返回。cpu 使用进程级全局线程池调度体素计算，无需 Vulkan；聚类过滤和导航膨胀沿用同一后端。线程数由共享线程池管理，不使用旧版 cpuWorkerCount。</td>
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
        <td>场景box限制（离群点对体素化性能影响极大且其输出无意义，所以目前采用最简单的方案限制了体素的生成范围）</td>
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
            两者均服务于导航简化功能。navCapsule用于设置导航体高度和半径，navSeed设置导航起始中心。
            开启后，会将体素按照导航体可达范围进行简化，能够优化体素（未完善，部分情况下可能存在副作用所以默认不开启）
        </td>
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

#### 数据选择与共享 LOD

以下任务的 input/output 是内存资源键，输出均为独立的单块 splat 资源，复制完整属性和全部 SH。结果的 offsets 为 [0]，counts 为 [结果点数]，并维护包围信息。

| Task            | config 字段                                      | 行为                                                                                                 |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Select          | input、output；indices 与 indicesPath 恰好二选一 | 按首次出现顺序稳定去重并复制，如 [8,2,8,5] → [8,2,5]，不做 Morton 排序                               |
| ReplaceAppend   | input、patch、output、sourceIndices              | patch 前 K 点依序替换唯一的源索引，其余追加；结果 N+M−K，要求 K≤M 且源/patch 的 SH 阶数及布局一致    |
| ExtractLodLevel | input、output、level（必填，0-based）            | 从本次 run 的 LOD bundle 按 tree 顺序复制指定层的 file/offset/count 区间，保留重复引用和独立 SH 存储 |

Select 的 .json 索引文件支持数组或含 indices 的对象；其他文件按小端 uint32 读取，.zst 先解压再读取。JSON 索引转换前验证整数和范围，不接受负数、小数、布尔值或越界值；二进制长度必须为 4 的倍数。空索引有效，空数据能否写出仍取决于目标格式。ReplaceAppend 的 sourceIndices 必填，可为空，但不能重复；保留的源、patch 及别名不会被修改。

Modify 先验证新增 rgba/maxShDegree，再执行原 patch 变换和删除，然后设置剩余点的 RGBA、截断 SH。不同 output 键仍是同一对象的别名。交互数据应先 ExtractLodLevel(level:3)，再 Modify(rgba:[0,0,0,1], maxShDegree:0)，不能直接修改共享源。

同一 LOD bundle 可以在一次 pipeline 中先 Write(highPrecision:false)，再 Write(highPrecision:true)；每次写出只读资源，内部仍可并行，只在最后使用后 release。bundle 的 preserve_order 标记仍禁止破坏区间的 Morton 重排。ExtractLodLevel 不支持从磁盘 lod-meta.json 恢复 bundle。

#### 使用样例

- 把 a.ply 和 b.ply 应用修改以后转换成 c.spz
    ```json
    {
        "version": 1,
        "tasks": [
            {
                "id": "0",
                "type": "Read",
                "config": {
                    "inputs": ["a.ply", "b.ply"],
                    "output": "cache0"
                }
            },
            {
                "id": "1",
                "type": "Modify",
                "config": {
                    "input": "cache0",
                    "output": "cache0",
                    "modifyPaths": ["a.json", "b.json"]
                }
            },
            {
                "id": "2",
                "type": "Write",
                "config": {
                    "input": "cache0",
                    "output": "c.spz"
                }
            }
        ]
    }
    ```
- 对 a.ply 应用修改以后生成 auto chunk lod
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
                "config": {
                    "input": "cache0",
                    "output": "cache0",
                    "modifyPaths": ["a.json"]
                }
            },
            {
                "id": "2",
                "type": "AutoChunkLod",
                "config": {
                    "input": "cache0",
                    "output": "cache0",
                    "type": "spz"
                }
            },
            {
                "id": "3",
                "type": "Write",
                "config": {
                    "input": "cache0",
                    "output": "a-lod"
                }
            }
        ]
    }
    ```
- 生成体素碰撞体
    ```json
    {
        "version": 1,
        "tasks": [
            {
                "id": "0",
                "type": "Read",
                "config": {
                    "inputs": ["input.ply"],
                    "output": "cache0"
                }
            },
            {
                "id": "1",
                "type": "Voxel",
                "config": {
                    "input": "cache0",
                    "output": "voxel-output",
                    "voxelResolution": 0.05,
                    "opacityCutoff": 0.1,
                    "navCapsule": {
                        "height": 1.4,
                        "radius": 0.2
                    },
                    "navSeed": {
                        "x": 0,
                        "y": 0,
                        "z": 0
                    }
                }
            }
        ]
    }
    ```

## 注意事项

- 当需要生成`SOG`或者使用`GPU`生成`Voxel`时，推荐使用性能较好的独立显卡。当转换比较大的数据到`SOG`时，需要10GB以上显存。
- 当生成`chunk-lod`时(既使用`AutoChunkLod`或者`lod:auto-chunk`生成)，推荐使用`spz`或者`esz`输出，在分块和多级`lod`后，会存在数据量很少数据量比较小的块，对于这些块`sog`压缩率表现不如`spz`，也可以配置`forceSpzFormatThreshold`来控制小于某个数量的块强制使用`spz`
- `chunk-lod`生成过程中对资源消耗比较大，推荐使用配置比较高的机器配置。对于大型数据推荐内存 >= 32GB, CPU核心数>=16(含超线程)。当无法直接生成时，可以先进行简单的块分割再生成，之后合并`lod-meta.json`，合并可以使用来自`@manycore/aholo-splat-dev-server@>=1.0.1`的`merge-lod`指令。
