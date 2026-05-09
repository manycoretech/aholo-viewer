---
title: splat-transform
description: splat-transform使用指南
order: 5
---

## 背景

`splat-transform`是面向 Aholo Viewer 的 3DGS 处理工具，用于格式转换、数据简化、LOD 生成和体素碰撞体生成。

## 环境需求

- Node.js >= 20.19.0
- Windows: Windows 22H2+，x86_64，D3D12 或 Vulkan 兼容显卡。需要 GPU 功能时，建议使用独立显卡。
- Linux: x86_64，glibc >= 2.34，libstdc++ >= 3.4.30，Vulkan 兼容显卡。需要 GPU 功能时，建议使用独立显卡。
- macOS: 暂不支持。

### 需要GPU的功能

- SOG 生成。
- Voxel 生成，且 `backend` 设置为 `gpu`。

## 格式说明

### 输入格式

- `ply`
- `sog`
- `ksplat`
- `splat`
- `spz`
- `lcc`
- `compressed.ply`，即 supersplat 压缩 ply
- `meta.json`，即 sog 未打包 meta 数据

### 输出格式

- `ply`
- `spz`
- `uspz`，即未 gzip 的 spz
- `splat`
- `sog`

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
splat-transform lod:auto-chunk --type <type:ply,spz,splat,sog> --max-chunk-counts <count> <input> <output> # 生成可以被调度的多级别lod数据，--max-chunk-counts 最大分块大小
```

### pipeline 模式(推荐)

```bash
splat-transform pipeline.json
```

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
        <td rowspan="3">Modify</td>
        <td rowspan="3">修改SplatData对象</td>
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
                <li>cpu</li>
                <li>gpu</li>
            </ul>
        </td>
        <td>N(gpu)</td>
        <td>生成方式，默认使用gpu，可选cpu。cpu的耗时会明显高于gpu。两者的结果会有细微差异。</td>
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

#### 使用样例

- 把 a.ply 和 b.ply 应用修改以后转换成 c.spz
    ```json:
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
                "input":
                "cache0",
                "output": "cache0",
                "modifyPaths": ["a.json","b.json"]
            }
        },
        {
            "id": "2",
            "type": "Write",
            "config": {
                "input":
                "cache0",
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
