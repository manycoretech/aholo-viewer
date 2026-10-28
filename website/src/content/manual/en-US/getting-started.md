---
title: Getting Started
description: Build a minimal Aholo-Viewer application with Vite.
order: 1
---

## Usage with Vite

### Install Dependencies

```bash
npm install --save @manycore/aholo-viewer
npm install --save-dev vite typescript # TypeScript is recommended.
```

### Create the Application Code

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
    // Create the container and attach it to the page.
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

        // The splat uses -Y up in OpenCV coordinates.
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

        // Render again when viewer.requestRender is called.
        viewer.requestRenderHandler = function () {
            requestAnimationFrame(render);
        };

        requestAnimationFrame(render);
    }

    createScene();
    ```

### Start the Application

```bash
npx vite
```

After Vite starts, open the local URL in your browser:

```
VITE v8.0.14  ready in 83 ms

Local:   http://localhost:5173/
Network: use --host to expose
press h + enter to show help
```

![Example](../assets/getting-started/example.png)

## Loading, Stream Consumption, and Cancellation

[`SplatLoader.parseSplatData()`](api:SplatLoader.parseSplatData) accepts a URL, `File`, `Uint8Array`, or `{ stream, contentLength }`. URLs and files are read in a worker. Pass an existing URL directly to avoid downloading the entire file on the main thread first. Complete encoded CPU data is retained by default for `serialize()` caching and existing editing APIs.

The fourth argument supports these options:

| Option       | Default            | Description                                                                                                                     |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `retainData` | `true`             | Retains complete encoded CPU data. Set to `false` to receive metadata and a single-consumer stream.                             |
| `chunkBytes` | `16 * 1024 * 1024` | Encoded chunk byte budget. Must be a positive safe integer. It does not affect rendering precision or cap total parsing memory. |
| `signal`     | None               | An `AbortSignal` that cancels parsing and stream consumption, releasing related worker tasks and readers.                       |

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

Call `controller.abort()` when switching assets or disposing the loading UI. With `retainData: false`, choose one consumption path:

- `await data.collect()`: collect complete CPU data, then call `createSplat(data)` or `serialize()`.
- `await data.readChunks(async chunk => { ... })`: process encoded chunks directly. `chunk.samplers` contains sampler indices, byte offsets, and chunk data. The caller owns the chunk buffers by default.
- `await SplatUtils.createSplat(data, renderer)`: provide the backend renderer from the host integration to upload chunks to WebGL2 or WebGPU. Native SOG is decoded and uploaded one image at a time.

A stream can only be consumed once. Call `data.cancel()` if it will not be consumed. After GPU upload or `readChunks()` consumption, `collect()` cannot collect the same stream again. `createSplat()` resolves after the upload finishes; this does not provide progressive display of partially downloaded Gaussians. The current public Viewer interface has no backend renderer accessor, so ordinary integrations can use the default CPU path or call `collect()` first.

### Restore CPU Data on Demand

[`Splat.stream`](api:Splat) is `true` while encoded source data is retained only on the GPU. Read it back before editing, export, or GPU resource recreation:

```typescript
await splat.readback();
// Applies to Compressed and SuperCompressed splats.
const cpuData = SplatUtils.createSplatData(splat);
const operator = new SplatUtils.SplatOperator(splat, cpuData);
```

After readback, `splat.stream` becomes `false` and the splat retains its encoded CPU data. Use the newly retrieved `cpuData` for CPU operations instead of the consumed stream object. `createSplatData()` supports `Compressed` and `SuperCompressed`, but not native SOG.

GPU-only sources depend on their original graphics context. If resources are released or the context/device is lost before readback, reload the original asset. `autoFreeResourceOnGpuPacked` preserves encoded source textures while they remain GPU-only.
