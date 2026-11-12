---
title: Aholo-Viewer Config 配置
description: 汇总 ViewerConfig、渲染模式和后期效果配置项。
order: 3
---

## 概览

`ViewerConfig` 控制 Aholo-Viewer 默认渲染行为

## 配置路径

```typescript
function setViewerConfig(ctx: Viewer | Viewport, config: IViewerConfig);
```

### [`PipelineConfig`](api:IPipelineConfig)

`pipeline` 用于控制管线功能，各部分通过 `enabled` 选项开关。

- [`Background`](api:IBackgroundPluginConfig): 用于控制背景(如天空盒)和地面网格的渲染行为。
- [`Composite`](api:ICompositePluginConfig): 用于控制输出前合成，一般用于优化多视图渲染性能。
- [`Splatting`](api:ISplattingPluginConfig): 用于控制`3DGS`渲染行为，具体参数说明可以参考[3dgs-preset-config](./3dgs-preset-config.md)。
- [`TAA`](api:ITaaPluginConfig): 用于控制静态时域超采样抗锯齿的渲染行为。

[完整参数说明](api:IViewerConfig)

## Splatting 排序与纹理重排

`pipeline.Splatting.sort.radial` 和 `pipeline.Splatting.pack.repackEnabled` 默认均为 `false`。

```typescript
import { setViewerConfig } from '@manycore/aholo-viewer';

setViewerConfig(viewer, {
    pipeline: {
        Splatting: {
            enabled: true,
            sort: {
                radial: true,
            },
            pack: {
                repackEnabled: true,
            },
        },
    },
});
```

| 参数                 | 默认值  | 说明                                                                                          |
| -------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `sort.radial`        | `false` | 按高斯中心到相机的距离排序；关闭时按视线方向深度排序。                                        |
| `pack.repackEnabled` | `false` | 在 WebGL 中按排序结果重排渲染纹理，减少光栅化时的间接纹理寻址；会增加显存占用和一次重排过程。 |

1.14 起，WebGL 统一按 float32 深度键的高 24 位稳定排序，与 WebGPU 一致。Worker 优先使用 WebAssembly SIMD，初始化失败时自动回退 JavaScript，无需手动选择实现。

仅相机变化且点中心数据未变时，WebGL 会复用点中心数据以减少 GPU 回读，并将排序与索引纹理上传并行处理。

径向距离与视线深度会产生不同的透明混合顺序，应结合实际场景评估。纹理重排的收益取决于场景和设备，可在 [Splatting 基础样例](/zh-CN/examples/splatting-basic/) 和 [LOD 流式加载样例](/zh-CN/examples/splatting-lod-stream/) 中切换对比。通过 `setViewerConfig()` 动态切换 `pack.precalculateEnabled` 或 `pack.repackEnabled` 时，会自动更新相关着色器。

## Splatting 合成与色调映射

`pipeline.Splatting.composite` 统一控制 3DGS 的离屏合成、色调映射和曝光，与顶层 `pipeline.Composite` 的输出合成配置相互独立。

```typescript
import { setViewerConfig, ToneMapping } from '@manycore/aholo-viewer';

setViewerConfig(viewer, {
    pipeline: {
        Splatting: {
            enabled: true,
            composite: {
                enabled: true,
                highPrecisionEnabled: true,
                toneMapping: ToneMapping.Neutral,
                exposure: 1,
            },
        },
    },
});
```

| 参数                   | 默认值               | 说明                                                                |
| ---------------------- | -------------------- | ------------------------------------------------------------------- |
| `enabled`              | `false`              | 同时开启离屏合成与色调映射；关闭后曲线和曝光设置不参与输出。        |
| `highPrecisionEnabled` | `false`              | 使用 `RGBA16F` 中间颜色缓冲；关闭时为 `RGBA8`，仅在合成开启时生效。 |
| `toneMapping`          | `ToneMapping.Linear` | 色调映射曲线。                                                      |
| `exposure`             | `1`                  | 曝光乘数。                                                          |

只需要离屏合成时，使用 `ToneMapping.Linear` 和 `exposure: 1`。曲线或曝光值本身不会开启合成，必须设置 `composite.enabled: true`。

## Splatting 配置迁移

高斯衰减现在统一使用归一化的 `fastExp` 公式，原 `raster.normalizedFalloff` 开关已移除。新增 `raster.detailCullingAlphaEnabled`，默认 `false`；开启后细节剔除会计入高斯透明度，与 `raster.detailCullingThreshold` 配合使用。WebGL 与 WebGPU 使用相同配置。

1.13 起，直接构造 `CompressedSplat` 或 `SuperCompressedSplat` 时，源纹理宽度必须为 2 的幂，否则会抛出异常。自定义纹理和反序列化的 sampler 数据都需满足该约束。新增的 `pack.repackEnabled` 需单独启用，旧 `pack.sortedLayoutEnabled` 仍需删除。

1.14 起，`Splatting.sort.highPrecisionEnabled` 不再生效，应从配置和预设中删除。`pack.highPrecisionEnabled` 和 `composite.highPrecisionEnabled` 仍分别控制数据合并与合成缓冲精度。

| 旧配置                                   | 迁移方式                                         |
| ---------------------------------------- | ------------------------------------------------ |
| `Splatting.toneMapping.enabled`          | 改为 `Splatting.composite.enabled`。             |
| `Splatting.toneMapping.toneMapping`      | 改为 `Splatting.composite.toneMapping`。         |
| `Splatting.toneMapping.exposure`         | 改为 `Splatting.composite.exposure`。            |
| `Splatting.pack.sortedLayoutEnabled`     | 已移除，从配置和预设中删除。                     |
| `Splatting.raster.normalizedFalloff`     | 已移除，从配置和预设中删除；衰减公式统一归一化。 |
| `Splatting.sort.highPrecisionEnabled`    | 1.14 起不再生效，从配置和预设中删除。            |
| `Splatting.sort.frustumCullingEnabled`   | 上游已移除，删除旧集成中的此项。                 |
| `Splatting.sort.frustumCullingClipScale` | 上游已移除，删除旧集成中的此项。                 |

旧版 tone mapping 会隐式使用浮点中间缓冲；迁移时需显式设置 `composite.highPrecisionEnabled: true` 才能保留该精度。不要保留独立的 `Splatting.toneMapping` 对象。

`SplatUtils.LodConfig.frustumCullingEnabled` 仍用于控制视锥外 LOD 分块卸载。新增的 `pixelLimitEnabled` 默认开启，用于控制基于视口像素密度的细化限制，详见 [Chunk LOD](./chunk-lod.md)。
