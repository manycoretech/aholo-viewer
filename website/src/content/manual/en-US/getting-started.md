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
            <script type="module" src="./index.js"></script>
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

        const resp = await fetch(SPLAT_URL);
        const buffer = await resp.arrayBuffer();
        const data = await SplatLoader.parseSplatData(
            SplatLoader.SplatFileType.SOG,
            new Uint8Array(buffer),
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
                    precalculateEnabled: true,
                    normalizedFalloff: false,
                    preBlurAmount: 0.3,
                    blurAmount: 0,
                    focalAdjustment: 2,
                    detailCullingThreshold: 0,
                    composite: {
                        enabled: true,
                        highPrecisionAttachEnabled: true,
                    },
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
