---
title: Aholo-Viewer Config
description: Reference for ViewerConfig, render modes, and post-processing options.
order: 3
---

## Overview

`ViewerConfig` controls the default rendering behavior of Aholo-Viewer.

## Configuration Path

```typescript
function setViewerConfig(ctx: Viewer | Viewport, config: IViewerConfig);
```

### [`PipelineConfig`](api:IPipelineConfig)

`pipelineConfig` controls all pipeline features. Each pipeline section can be toggled with the `enable` option.

- [`Background`](api:IBackgroundPluginConfig): Controls background rendering, such as skyboxes and ground grids.
- [`Composite`](api:ICompositePluginConfig): Controls composition before output, usually to optimize multi-view rendering performance.
- [`Splatting`](api:ISplattingPluginConfig): Controls `3DGS` rendering behavior. For detailed parameter guidance, see [3dgs-preset-config](./3dgs-preset-config.md).
- [`TAA`](api:ITaaPluginConfig): Controls static temporal supersampling anti-aliasing.

[Full Parameter Reference](api:IViewerConfig)
