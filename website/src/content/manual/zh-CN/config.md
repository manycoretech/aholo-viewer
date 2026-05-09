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

pipelineConfig用于控制所有的管线功能，每个管线部分可以通过`enable`选项进行开关。

- [`Background`](api:IBackgroundPluginConfig): 用于控制背景(如天空盒)和地面网格的渲染行为。
- [`Composite`](api:ICompositePluginConfig): 用于控制输出前合成，一般用于优化多视图渲染性能。
- [`Splatting`](api:ISplattingPluginConfig): 用于控制`3DGS`渲染行为，具体参数说明可以参考[3dgs-preset-config](./3dgs-preset-config.md)。
- [`TAA`](api:ITaaPluginConfig): 用于控制静态时域超采样抗锯齿的渲染行为。

[完整参数说明](api:IViewerConfig)
