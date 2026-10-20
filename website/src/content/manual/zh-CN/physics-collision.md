---
title: 物理碰撞
description: 从 3DGS 场景生成体素或网格碰撞体，并做射线、胶囊体等实时碰撞查询。
order: 6
---

## 背景

3DGS 重建场景是高斯点云，没有实体边界，无法直接用于行走与碰撞。物理碰撞模块把重建空间转换为**可查询的碰撞数据**，用体素或网格描述地面、墙体、遮挡物和可通行区域，为行走模式、相机避障、区域限制和空间交互提供约束。

体素碰撞体由 `splat-transform` 的 `Voxel` 任务从 3DGS 资产生成。完整生成参数、CPU/GPU 后端和回退规则见 [Voxel 任务](./splat-transform.md#voxel)。设置 `collisionMesh: "smooth"` 或 `"faces"` 可同时生成 `collision.glb` 网格碰撞体。

## 概述

体素数据将场景占用编码为 **稀疏体素八叉树（SVO）**，用于运行时碰撞与射线检测，例如：

- **Raycast**：拾取、贴地、视线检测
- **球体 / 胶囊体**：角色穿透修正（depenetration）

编码采用 **Laine–Karras** 紧凑布局，与 [playcanvas/splat-transform](https://github.com/playcanvas/splat-transform)、[playcanvas/supersplat-viewer](https://github.com/playcanvas/supersplat-viewer) 约定一致。

## 稀疏八叉树结构

八叉树在均匀体素网格上划分空间，只存储**非空**区域，以压缩大场景数据。

**层级**

- 根到叶共 `treeDepth` 层；最细一层体素边长为 `voxelResolution`。
- 每个叶节点覆盖 **4×4×4** 体素（`leafSize = 4`），共 64 个占用位。

**节点类型**（`nodes` 数组中每个 `uint32`）

| 类型           | 含义                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| **内部节点**   | 高 8 位为 `childMask`（8 个子八分体是否存在），低 24 位为第一个子节点在数组中的索引；其余子节点下标由 popcount 推算。 |
| **全实心节点** | 值为 `0xFF000000`（`SOLID_LEAF_MARKER`），表示该节点覆盖区域全部占用，可在到达最细叶块前结束遍历。                    |
| **混合叶**     | `childMask == 0`，低 24 位为 64 位叶位图的索引 `n`，对应 `leafData[2*n]` 和 `leafData[2*n+1]`。                       |

**`leafData`**

- 每个混合叶占 2 个 `uint32`（`lo`、`hi`），共 64 bit。
- 块内体素 `(vx, vy, vz)` 的位索引：`vx + vy * 4 + vz * 16`（各分量 ∈ [0, 3]）。

**遍历**

`nodes` 按广度优先紧凑存储，只保留 `childMask` 标记存在的子节点。查询时从根沿**一条路径**下潜 `treeDepth` 层，无需遍历整棵树。

**查询单个体素是否占用**：世界坐标 → 体素 `(ix, iy, iz)` → 叶块 `(⌊ix/4⌋, …)`。从 `nodes[0]` 向下：

- **全实心叶**：判定为占用。
- **混合叶**：用 `(ix&3, iy&3, iz&3)` 查 `leafData` 对应位。
- **内部节点**：按当前层从叶块坐标取八分体编号；若无子节点则为空，否则下一节点下标为 `baseOffset` 加 popcount。

**射线遍历**：在网格包围盒内用 3D DDA 逐格前进，每格重复上述占用查询。

## 输出文件与编码

默认配置为 `nodeEncoding: "raw"`、`compression: "none"`。编码和压缩是两个独立选项；可使用 compact 节点编码后再 gzip 或 zstd 压缩。

| 文件              | 说明                                        |
| ----------------- | ------------------------------------------- |
| `voxel-meta.json` | 元数据及当前二进制文件名。                  |
| `voxel.bin`       | `compression: "none"`。                     |
| `voxel.bin.gz`    | `compression: "gzip"`。                     |
| `voxel.bin.zst`   | `compression: "zstd"`。                     |
| `collision.glb`   | 启用 `collisionMesh` 且产生非空网格时写出。 |

### 元数据

```typescript
interface VoxelMetadata {
    version: '1.2';
    gridBounds: { min: [number, number, number]; max: [number, number, number] };
    sceneBounds: { min: [number, number, number]; max: [number, number, number] };
    voxelResolution: number;
    leafSize: 4;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
    files: string[];
    nodeEncoding: 'raw' | 'compact';
    compression: 'none' | 'gzip' | 'zstd';
}
```

`files` 中的路径相对于 `voxel-meta.json` 所在目录。`nodeCount` 是解码后的 uint32 节点数，`leafDataCount` 是 uint32 叶数据数，等于 `numMixedLeaves * 2`。网格容量或八叉树索引超限时，生成器可能增大体素边长，查询必须使用元数据中的实际 `voxelResolution` 和 `gridBounds`。

### raw 编码

解压后连续存储小端 uint32：先是 `nodeCount` 个节点，再是 `leafDataCount` 个叶数据。字节长度应为 `4 * (nodeCount + leafDataCount)`。混合叶位图的低 32 位在前，高 32 位在后。

### compact 编码

compact 是磁盘编码，不能直接按 raw 的 `nodes + leafData` 读取。解压后包含：

1. 32 字节头部，依次为 8 个小端 uint32：magic `0x31424356`（`VCB1`）、编码版本 `1`、节点数、内部节点数、混合叶数、叶数据 uint32 数、tag 字节数、child-mask 字节数。
2. 节点 tag，每节点 2 bit，低位优先；`0` 为混合叶，`1` 为全实心节点，`2` 为内部节点，`3` 保留。tag 字节数为 `ceil(nodeCount / 4)`。
3. 每个内部节点一个 child mask 字节，按节点顺序存储。
4. 补零至 4 字节对齐，再存储小端 uint32 叶数据。

解码时按广度优先的节点顺序重建 raw 数组：内部节点的首子节点索引从 `1` 开始累加 `popcount(childMask)`；混合叶索引从 `0` 递增；全实心节点恢复为 `0xFF000000`。解码器应校验头部、tag、计数和文件长度。

### 读取流程

1. 读取元数据，并相对于元数据 URL 解析 `files[0]`。
2. 按 `compression` 解压二进制；HTTP 已通过 `Content-Encoding` 透明解压时不要重复解压。
3. 按 `nodeEncoding` 读取 raw，或将 compact 解码成 raw 节点与叶数据。
4. 将解码后的数组和元数据交给运行时查询。Chunk LOD 的 `parseVoxel` 需要 `nodes` 在前、`leafData` 在后的 `Uint32Array`，见 [体素遮挡降级](./chunk-lod.md#体素遮挡降级)。

生成器覆盖同名体素文件，但不会清空目录。切换压缩方式或关闭网格输出后可能保留旧文件，应以本次配置及元数据为准。

## Raycast 与碰撞查询

`splat-transform` 只负责**生成**体素数据；射线检测、穿透修正等由**运行时**加载八叉树后实现。常见流程如下。

**射线检测（Raycast）**

1. 射线与网格包围盒求交，限定搜索范围；
2. 用 **3D DDA** 沿射线逐格前进：比较与各轴体素边界的参数 `t`，进入 `t` 最小的一格；
3. 每格沿八叉树下潜，查询是否占用；
4. 遇到第一个实心体素即为交点；走出包围盒仍未命中则视为无交。

射线方向不必归一化。常用于贴地、拾取、短距离障碍检测。

**位置占用**

给定世界坐标，映射为体素索引后，按上文方式查询是否在物体内部。

**球体 / 胶囊体**

在包围体内的体素格中，对每个实心体素的轴对齐方块，计算与球心或胶囊轴线的距离；小于半径则存在穿透，沿最短方向累加推出位移。多面接触时可迭代若干次。

## 致谢

体素管线、八叉树编码及文件格式主要参考 PlayCanvas 开源项目：

| 项目                  | 链接                                            | 说明                                                                                                                |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **splat-transform**   | https://github.com/playcanvas/splat-transform   | 体素化、导航填充/雕刻、八叉树导出与碰撞网格生成                                                                     |
| **supersplat-viewer** | https://github.com/playcanvas/supersplat-viewer | 运行时体素碰撞（raycast、球/胶囊查询）参考实现；见 [Issues](https://github.com/playcanvas/supersplat-viewer/issues) |
