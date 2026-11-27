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
    // Create the container and attach it to the page.
    const container = document.createElement('div');
    container.style.width = '500px';
    container.style.height = '500px';
    container.style.display = 'block';
    document.body.appendChild(container);

    async function createScene() {
        const viewer = createViewer('example-viewer', container, {});
        const camera = new PerspectiveCamera(60, 1, 0.1, 2000);

        // The splat uses -Y up in OpenCV coordinates.
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

## Multithreaded WebGL Sorting

From 1.16.0, the WebGL sorter can share point centers and sorted indices through `SharedArrayBuffer` and use helper threads on supported devices. Serve the application over HTTPS or use `localhost` for development. In a Vite project, save the following as `vite.config.ts` to set the development headers and preserve the SDK's worker asset paths.

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

In production, set the same two headers on the **HTML response that hosts the viewer**. Evaluate `window.crossOriginIsolated` in the browser console. It should return `true`.

JavaScript assets can live on a separate origin. Serve them as JavaScript modules with `Access-Control-Allow-Origin` set to the host origin or `*` for public assets. Set `crossorigin="anonymous"` on cross-origin stylesheets and images to request them in CORS mode. In this deployment only the host HTML needs the isolation headers.

When serving the npm package directly, preserve the full `dist/` layout, including `splat-sort-worker.js` and `sort-wasm/sort.js`, which embeds the WASM binary. The sorting worker and its cross-origin helpers start from Blob URLs on the host origin and import the CDN modules. If the site uses CSP, its worker policy must allow `blob:`.

## Loading and Streaming Uploads

Starting in 1.15.0, [`SplatLoader.parseSplatData()`](api:SplatLoader.parseSplatData) enables streaming by default. It accepts a URL, `File`, `Uint8Array`, or `{ stream, contentLength }`. The first three arguments specify the file format, input, and pack type. The fourth argument controls parsing.

| Option             | Default            | Purpose                                                                                                                                                             |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`           | `true`             | Allows a direct GPU upload. Set to `false` to collect the CPU sampler data before the parser returns.                                                               |
| `mortonSort`       | `true`             | Reorders decoded points by the Morton order of their centers. Set to `false` to keep file order and emit chunks. Native `SplatPackType.Sog` keeps its image layout. |
| `streamChunkBytes` | `16 * 1024 * 1024` | Target byte size for encoded chunks in file order. Chunks align to texture rows.                                                                                    |

The default Morton sort reads the full point set before returning. Set `mortonSort: false` to upload chunks as they are parsed or to address Gaussians by their original file indices.

The example above uses the default `stream: true`. Its call to `createSplat(data)` collects CPU data and returns a splat with `autoFreeResourceOnGpuPacked` set to `true`. Passing an uncollected streaming result to `createSplat(data, renderer)` uploads it directly to an initialized WebGL2 or WebGPU renderer. After upload, the SDK sets the property to `false` and releases the CPU copy. If the GPU source textures are subsequently freed, a later packing pass requires reloading the original asset. See [Releasing GPU Source Textures After Packing](./config.md#releasing-gpu-source-textures-after-packing).

### Retain CPU Data for Editing, Caching, or Export

The quick start above calls `await SplatUtils.createSplat(data)`, which collects CPU data automatically. To cache the data before creating a splat, request CPU samplers and original file indices during parsing.

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

For an existing streaming result, call `await data.collect()` before upload and read from the same `data` object. The method returns `Promise<void>`. A direct GPU upload consumes the result. Reparse the original asset for later editing or to rebuild these resources after context loss.

### Migrate from 1.14

- Replace `retainData: true` with `stream: false` and `retainData: false` with `stream: true`. Rename `chunkBytes` to `streamChunkBytes`.
- Migrate `data.readChunks()` and `data.cancel()` to `data.stream?.chunks`. In file-order chunk mode, this single-consumer `ReadableStream` emits `{ index, offset, source }` for one sampler at a time. Offsets are in bytes. Copy `source` before the next read if you need to retain it. Call `chunks.cancel()` to discard an unlocked stream or `reader.cancel()` if you hold its reader.
- To cancel a URL download, pass the `AbortSignal` to `fetch(url, { signal })` and pass the response body and byte length to the parser. Version 1.15.0 removes the `signal` option from `parseSplatData()`.
- Passing a `Uint8Array` transfers its backing buffer to the worker. Pass `bytes.slice()` if you need the original bytes or another view of that buffer.
- Migrate code that uses `splat.stream` or `splat.readback()` to retain CPU data before creating the splat. `SplatUtils.createSplatData(splat)` can retrieve samplers from CPU-backed `Compressed` and `SuperCompressed` instances.
