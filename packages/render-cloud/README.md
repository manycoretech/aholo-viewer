# Render Cloud (`@manycore/aholo-viewer` / `RenderCloud`)

Render Cloud TypeScript client（OpenAPI `RenderCloud`：REST + WebSocket）。从主包 namespace 导入：

```typescript
import { RenderCloud } from '@manycore/aholo-viewer';
```

## 构建

在仓库根目录构建 renderer（会一并打包 `RenderCloud`）：

```bash
pnpm build:renderer
```

## 最小示例

```typescript
import { RenderCloud } from '@manycore/aholo-viewer';

const session = await RenderCloud.createRealtimeSession(
    {
        origin: 'https://api-beta.aholo3d.cn',
        getAppKey: () => yourAppKey,
    },
    {
        usda: openUsdAscii,
        onFrame: frame => {
            const url = URL.createObjectURL(frame.data);
            // draw JPEG (frame.mimeType === "image/jpeg")
            URL.revokeObjectURL(url);
        },
    },
);

session.pushCamera({
    transform: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 5, 1],
    ],
    focalLength: 24,
    horizontalAperture: 36,
    verticalAperture: 24,
    resolution: { width: 1280, height: 720 },
});

await session.close();
```

`RenderCloudConfig.apiPrefix` 默认为 `/rendercloud/v1`；`origin` 按环境填写（生产 `https://api.aholo3d.cn`，联调 `https://api-beta.aholo3d.cn`）。

鉴权：请求头 `Authorization: <AppKey>`（不要 `Bearer` 前缀）。本地 Playground 示例见 `website/src/content/examples/render-cloud-realtime.ts`。
