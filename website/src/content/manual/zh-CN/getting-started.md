---
title: 快速开始
description: 快速开始
order: 1
---

## 使用方式(以Vite为例)

### 安装相关依赖

```bash
npm install --save @manycore/aholo-viewer
npm install --save-dev vite typescript # 推荐使用typescript开发
```

### 创建代码

- `index.html`

    ```html
    <!doctype html>
    <html>
        <head>
            <title>My first aholo viewer app</title>
        </head>
        <body>
            <script type="module" src="./index.ts"></script>
        </body>
    </html>
    ```

- `index.ts`

    ```javascript
    import {
        createViewer,
        setViewerConfig,
        PerspectiveCamera,
        BackgroundMode,
        Vector3,
        Color,
        SplatLoader,
        SplatUtils,
    } from '@manycore/aholo-viewer';

    const SPLAT_URL = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/bear/bear.3d71a266.sog';
    // create container & append
    const container = document.createElement('div');
    container.style.width = '500px';
    container.style.height = '500px';
    container.style.display = 'block';
    document.body.appendChild(container);

    async function createScene() {
        const viewer = createViewer('example-viewer', container, {});
        const camera = new PerspectiveCamera(60, 1, 0.1, 2000);

        // the splat is -Y UP, open cv coordinate
        camera.up.set(0, -1, 0);
        camera.position.set(-1.5, -0.5, 0);
        camera.lookAt(new Vector3(0, 0, 0));

        viewer.setCamera(camera);
        setViewerConfig(viewer, {
            pipeline: {
                Background: {
                    background: {
                        active: BackgroundMode.BasicBackground,
                        basic: {
                            color: new Color(0, 0, 0),
                        },
                    },
                    ground: {
                        enabled: false,
                    },
                },
                Splatting: {
                    enabled: true,
                },
                TAA: {
                    enabled: false,
                },
            },
        });

        const data = await SplatLoader.parseSplatData(
            SplatLoader.SplatFileType.SOG,
            SPLAT_URL,
            SplatLoader.SplatPackType.Compressed,
        );
        const splat = await SplatUtils.createSplat(data);
        viewer.getScene().add(splat);

        function render() {
            viewer.render();
        }

        // handle viewer.requestRender call
        viewer.requestRenderHandler = function () {
            requestAnimationFrame(render);
        };

        requestAnimationFrame(render);
    }

    createScene();
    ```

### 启动应用

```bash
npx vite
```

看到如下输出后，在浏览器内打开链接即可：

```
VITE v8.0.14  ready in 83 ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
➜  press h + enter to show help
```

![样例](../assets/getting-started/example.png)

## WebGL 多线程排序

从 1.16.0 起，WebGL 排序可以通过 `SharedArrayBuffer` 共享点中心和排序结果，并在支持的设备上启用辅助线程。生产环境使用 HTTPS，本地开发可使用 `localhost`。在 Vite 项目中，将以下配置保存为 `vite.config.ts`，让开发服务器返回隔离响应头，并保留 SDK 的 Worker 资源路径。

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    optimizeDeps: { exclude: ['@manycore/aholo-viewer'] },
});
```

部署时，在**承载 Viewer 的 HTML 响应**上设置同样的两个头。在浏览器控制台执行 `window.crossOriginIsolated`，应返回 `true`。

JS 可以部署在另一个源。CDN 按 JavaScript 模块提供资源，返回允许主站源的 `Access-Control-Allow-Origin`，公开资源也可使用 `*`。跨源样式表和图片使用 `crossorigin="anonymous"` 发起 CORS 请求。在这种部署方式下，隔离头只需随主站 HTML 返回。

直接部署 npm 包时，保留完整的 `dist/` 目录结构，包括 `splat-sort-worker.js` 和内嵌 WASM 的 `sort-wasm/sort.js`。排序 Worker 和跨源辅助线程从主站源的 Blob URL 启动，再导入 CDN 模块。若站点使用 CSP，Worker 策略需允许 `blob:`。

## 加载与流式上传

从 1.15.0 起，[`SplatLoader.parseSplatData()`](api:SplatLoader.parseSplatData) 默认开启流式加载。它接受 URL、`File`、`Uint8Array` 或 `{ stream, contentLength }`。前三个参数指定文件格式、输入和打包格式，第四个参数控制解析行为。

| 选项               | 默认值             | 用途                                                                                                                   |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `stream`           | `true`             | 允许将解析结果直接上传到 GPU。设为 `false` 会在返回前收齐 CPU 采样器数据。                                             |
| `mortonSort`       | `true`             | 按高斯中心的 Morton 顺序排列解码后的点。设为 `false` 可保留文件点序并逐块输出。原生 `SplatPackType.Sog` 保留图像布局。 |
| `streamChunkBytes` | `16 * 1024 * 1024` | 按文件点序输出时，每个编码块的目标字节数。块按纹理行对齐。                                                             |

默认的 Morton 排序需要先读完整个点集。需要在解析时逐块上传，或需要用原文件索引编辑高斯时，设置 `mortonSort: false`。

上方示例使用默认的 `stream: true`，调用 `createSplat(data)` 时会收齐 CPU 数据，对象的 `autoFreeResourceOnGpuPacked` 初始值为 `true`。如果把尚未收集的流式结果传给 `createSplat(data, renderer)`，已初始化的 WebGL2 或 WebGPU renderer 会直接接收数据。上传完成后，SDK 将该对象的属性设为 `false` 并释放 CPU 副本。这种加载方式下，如果随后又释放 GPU 源纹理，重新打包就需要重载原文件。见[打包后释放 GPU 源纹理](./config.md#打包后释放-gpu-源纹理)。

### 为编辑、缓存或导出保留 CPU 数据

上方快速开始中的 `await SplatUtils.createSplat(data)` 会自动收齐 CPU 数据。如果要在创建 splat 前写入缓存，可以在解析时显式保留数据和原文件索引。

```typescript
const data = await SplatLoader.parseSplatData(
    SplatLoader.SplatFileType.SOG,
    SPLAT_URL,
    SplatLoader.SplatPackType.Compressed,
    { stream: false, mortonSort: false },
);
const snapshot = data.serialize();
const splat = await SplatUtils.createSplat(data);
const operator = new SplatUtils.SplatOperator(splat, data);
```

已有流式结果时，可在上传前执行 `await data.collect()`，随后从原 `data` 读取。它返回 `Promise<void>`。直接 GPU 上传会消费该结果，后续编辑或在图形上下文丢失后重建资源需要重新解析原始文件。

### 从 1.14 迁移

- 将 `retainData: true` 改为 `stream: false`。原 `retainData: false` 对应 `stream: true`。将 `chunkBytes` 改为 `streamChunkBytes`。
- 原 `data.readChunks()` 和 `data.cancel()` 改用 `data.stream?.chunks`。按文件点序解析时，这条单次消费的 `ReadableStream` 按采样器输出 `{ index, offset, source }`，`offset` 以字节为单位。需要保留 `source` 时，在读取下一块前复制。放弃尚未锁定的流时调用 `chunks.cancel()`，已取得 reader 时调用 `reader.cancel()`。
- 加载 URL 时，将 `AbortSignal` 传给 `fetch(url, { signal })`，再将响应体与字节长度交给解析器。1.15.0 移除了 `parseSplatData()` 的 `signal` 选项。
- 传入 `Uint8Array` 会把底层缓冲区转移到 Worker。如果原始字节或共享缓冲区的其他视图还要使用，传入 `bytes.slice()`。
- 将依赖 `splat.stream` 或 `splat.readback()` 的逻辑改为在创建 splat 前保留 CPU 数据。`SplatUtils.createSplatData(splat)` 可从有 CPU 源数据的 `Compressed` 和 `SuperCompressed` 实例取得采样器。
