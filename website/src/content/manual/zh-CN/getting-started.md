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
    <!DOCTYPE html>
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

        const data = await SplatLoader.parseSplatData(
            SplatLoader.SplatFileType.SOG,
            SPLAT_URL,
            SplatLoader.SplatPackType.Compressed,
        );
        const splat = await SplatUtils.createSplat(data);

        // the splat is -Y UP, open cv coordinate
        camera.up.set(0, -1, 0);
        camera.position.set(-1.5, -0.5, 0);
        camera.lookAt(new Vector3(0, 0, 0));

        viewer.getScene().add(splat);
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

## 加载、流式消费与取消

[`SplatLoader.parseSplatData()`](api:SplatLoader.parseSplatData) 接受 URL、`File`、`Uint8Array` 或 `{ stream, contentLength }`。URL 和 `File` 在 Worker 中读取；已有 URL 时可直接传入，避免先在主线程下载完整文件。默认保留完整 CPU 编码数据，可继续使用 `serialize()` 缓存和现有编辑接口。

第四个参数支持以下选项：

| 选项         | 默认值             | 说明                                                                                 |
| ------------ | ------------------ | ------------------------------------------------------------------------------------ |
| `retainData` | `true`             | 保留完整 CPU 编码数据。设为 `false` 时返回元数据和单次消费流。                       |
| `chunkBytes` | `16 * 1024 * 1024` | 编码块的字节预算，必须是正安全整数；不影响渲染精度，也不代表整个解析过程的内存上限。 |
| `signal`     | 无                 | `AbortSignal`，用于中止解析和流消费，并释放相关 Worker 任务与读取器。                |

```typescript
const controller = new AbortController();
const data = await SplatLoader.parseSplatData(
    SplatLoader.SplatFileType.SOG,
    SPLAT_URL,
    SplatLoader.SplatPackType.Compressed,
    { signal: controller.signal },
);
const splat = await SplatUtils.createSplat(data);
if (controller.signal.aborted) {
    splat.destroy();
    controller.signal.throwIfAborted();
}
viewer.getScene().add(splat);
viewer.render();
```

在切换资源或销毁加载界面时调用 `controller.abort()`。如果设置了 `retainData: false`，需选择一种消费方式：

- `await data.collect()`：收集为完整 CPU 数据，然后可调用 `createSplat(data)` 或 `serialize()`。
- `await data.readChunks(async chunk => { ... })`：自定义处理编码块。`chunk.samplers` 包含 sampler 索引、字节偏移和块数据；默认由调用方持有块缓冲。
- `await SplatUtils.createSplat(data, renderer)`：由宿主集成提供底层 renderer 实例，将流按块上传到 WebGL2 或 WebGPU；native SOG 按图片解码上传。

流只能消费一次。放弃消费时调用 `data.cancel()`；GPU 上传或 `readChunks()` 消费后，不能再通过 `collect()` 收集同一条流。流式上传完成后 `createSplat()` 才返回，不表示可以边下载边显示部分高斯。当前公开 Viewer 接口未提供底层 renderer 获取入口，常规接入可使用默认 CPU 路径或先调用 `collect()`。

### 按需恢复 CPU 数据

[`Splat.stream`](api:Splat) 为 `true` 表示编码源数据仅保留在 GPU。需要编辑、导出或重建 GPU 资源时，先回读：

```typescript
await splat.readback();
// Applies to Compressed and SuperCompressed splats.
const cpuData = SplatUtils.createSplatData(splat);
const operator = new SplatUtils.SplatOperator(splat, cpuData);
```

回读后 `splat.stream` 变为 `false`，CPU 编码数据保留在 splat 中；需要 CPU 数据的接口应使用重新获取的 `cpuData`，不要继续使用已消费的流对象。`createSplatData()` 支持 `Compressed` 和 `SuperCompressed`，不支持 native SOG。

GPU-only 源数据依赖创建时的图形上下文。在回读前释放资源或丢失上下文/设备，需要重新加载原始资源。`autoFreeResourceOnGpuPacked` 不会释放仍处于 GPU-only 状态的编码源纹理。
