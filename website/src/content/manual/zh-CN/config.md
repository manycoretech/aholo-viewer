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

| 旧配置                                   | 迁移方式                                         |
| ---------------------------------------- | ------------------------------------------------ |
| `Splatting.toneMapping.enabled`          | 改为 `Splatting.composite.enabled`。             |
| `Splatting.toneMapping.toneMapping`      | 改为 `Splatting.composite.toneMapping`。         |
| `Splatting.toneMapping.exposure`         | 改为 `Splatting.composite.exposure`。            |
| `Splatting.pack.sortedLayoutEnabled`     | 已移除，从配置和预设中删除。                     |
| `Splatting.raster.normalizedFalloff`     | 已移除，从配置和预设中删除；衰减公式统一归一化。 |
| `Splatting.sort.frustumCullingEnabled`   | 上游已移除，删除旧集成中的此项。                 |
| `Splatting.sort.frustumCullingClipScale` | 上游已移除，删除旧集成中的此项。                 |

旧版 tone mapping 会隐式使用浮点中间缓冲；迁移时需显式设置 `composite.highPrecisionEnabled: true` 才能保留该精度。不要保留独立的 `Splatting.toneMapping` 对象。

`SplatUtils.LodConfig.frustumCullingEnabled` 仍用于控制视锥外 LOD 分块卸载。新增的 `pixelLimitEnabled` 默认开启，用于控制基于视口像素密度的细化限制，详见 [Chunk LOD](./chunk-lod.md)。
