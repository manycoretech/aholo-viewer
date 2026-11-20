---
name: use-aholo-viewer
description: Guide external npm package users and AI coding agents integrating @manycore/aholo-viewer into web applications. Use when asked to install, bootstrap, render 3D Gaussian Splatting or mesh content, configure cameras, scenes, lighting, viewer pipeline options, or write TypeScript examples for the public @manycore/aholo-viewer npm package.
---

# Use Aholo Viewer

Use this skill to build or modify user applications that consume the public `@manycore/aholo-viewer` npm package. Treat it as a full-featured browser rendering package, not as this repository's internal renderer source.

## Source Docs

Before generating non-trivial code, read the AI-oriented docs advertised by `https://aholojs.dev/llms.txt`:

- `https://aholojs.dev/llm/manual/getting-started.md` for installation and the minimal Vite setup.
- `https://aholojs.dev/llm/manual/basic-concepts.md` for scenes, objects, cameras, viewports, and the render flow.
- `https://aholojs.dev/llm/api/index.md` to confirm public exports.
- `https://aholojs.dev/llm/examples/index.md` for runnable TypeScript patterns.

Prefer these Markdown docs over scraping rendered HTML pages.

## Integration Workflow

1. Install the package in a browser app:

    ```bash
    npm install --save @manycore/aholo-viewer
    npm install --save-dev vite typescript
    ```

2. Import only public package exports from `@manycore/aholo-viewer`.

3. Create a real DOM container with stable dimensions before calling `createViewer`. Attach application DOM event listeners to this container, not to the engine canvas.

4. Create a camera, position it, call `lookAt`, and set it with `viewer.setCamera(camera)`. Configure the rendering pipeline with `setViewerConfig(viewer, { pipeline: ... })`.

5. Load the assets and add their objects to `viewer.getScene()`. For splats that use `autoFreeResourceOnGpuPacked`, choose packing precision, SH precalculation, and camera-relative packing before loading. Changing these options later requires the source data again.

6. Render explicitly with `viewer.render()`. If the app relies on viewer-triggered invalidation, set `viewer.requestRenderHandler` to schedule another render with `requestAnimationFrame`.

7. Clean up when removing content: detach scene objects, stop render/update loops that still reference them, then release GPU resources or owned resources according to the cleanup rules below.

## Minimal Splat Example

Use this pattern for a Vite/TypeScript browser entry:

```ts
import {
    BackgroundMode,
    Color,
    PerspectiveCamera,
    SplatLoader,
    SplatUtils,
    Vector3,
    createViewer,
    setViewerConfig,
} from '@manycore/aholo-viewer';

const SPLAT_URL = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/bear/bear.3d71a266.sog';

const container = document.createElement('div');
container.style.width = '500px';
container.style.height = '500px';
document.body.appendChild(container);

async function main() {
    const viewer = createViewer('example-viewer', container, {});
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);

    camera.up.set(0, -1, 0);
    camera.position.set(-1.5, -0.5, 0);
    camera.lookAt(new Vector3(0, 0, 0));

    viewer.setCamera(camera);
    setViewerConfig(viewer, {
        pipeline: {
            Background: {
                background: {
                    active: BackgroundMode.BasicBackground,
                    basic: { color: new Color(0, 0, 0) },
                },
                ground: { enabled: false },
            },
            Splatting: { enabled: true },
            TAA: { enabled: false },
        },
    });

    const response = await fetch(SPLAT_URL);
    const buffer = await response.arrayBuffer();
    const data = await SplatLoader.parseSplatData(
        SplatLoader.SplatFileType.SOG,
        new Uint8Array(buffer),
        SplatLoader.SplatPackType.Compressed,
    );
    const splat = await SplatUtils.createSplat(data);
    viewer.getScene().add(splat);

    const render = () => viewer.render();
    viewer.requestRenderHandler = () => requestAnimationFrame(render);
    requestAnimationFrame(render);
}

main();
```

## Common Public Exports

- Viewer setup: `createViewer`, `setViewerConfig`, `Viewer`, `Viewport`.
- Cameras and math: `PerspectiveCamera`, `OrthographicCamera`, `Vector2`, `Vector3`, `Vector4`, `Color`, `Matrix4`, `Quaternion`.
- Scene objects: `Object3D`, `Scene3D`, `Mesh`, `Splat`, `AmbientLight`, `DirectionalLight`, `PointLight`, `SpotLight`.
- Mesh content: `BufferGeometry`, `BufferAttribute`, `MeshBasicMaterial`, `MeshPhongMaterial`, `Side`, `downloadTexture`.
- Splat content: `SplatLoader`, `SplatUtils`, `CompressedSplat`, `SuperCompressedSplat`, `SogSplat`.
- Optional loaders/utilities: `GLTFLoader`, `DracoLoader`, `Animation`, `Events`.

Confirm exact symbols in `/llm/api/index.md` when using less common APIs.

## Patterns

For 3DGS content:

- `SplatLoader.parseSplatData(...)` defaults to streaming and Morton order for decoded splats. Pass `{ mortonSort: false }` when indices refer to file order, including in custom chunk LOD loaders.
- `await SplatUtils.createSplat(data)` collects CPU data automatically. To serialize or edit parsed data before creating the splat, pass `{ stream: false }` during parsing or call `await data.collect()` first.
- Enable `pipeline.Splatting`.
- Set camera up vectors deliberately. OpenCV-style 3DGS data commonly uses `camera.up.set(0, -1, 0)`.

For mesh content:

- Build geometry with `BufferGeometry`, `BufferAttribute`, and optional indices.
- Use `MeshPhongMaterial` with lights for shaded meshes, or `MeshBasicMaterial` for unlit objects.
- Add lights such as `AmbientLight`, `DirectionalLight`, or `PointLight` before rendering lit materials.

For interactive apps:

- Tie camera controls or animations to a frame loop that calls `viewer.render()`.
- Keep viewer container size stable and update rendering after layout changes.
- Register pointer, wheel, keyboard focus, drag/drop, resize, and custom DOM event listeners on the viewer container or another application-owned element.
- Cache large splat data when appropriate, but keep the first example simple unless the user asks for caching.

## DOM Events and Canvas Access

Treat the container as the stable application boundary:

- Listen for DOM events on the `container` passed to `createViewer(...)`, or on another element owned by the application.
- Do not attach event listeners to the viewer canvas. The canvas is managed internally by the engine and may be replaced.
- Do not persistently store the engine canvas element in application state, class fields, module globals, framework refs, or closures intended to outlive the current operation.
- If direct canvas access is unavoidable, read it just-in-time from the current viewer/container state, use it immediately, and discard the reference.
- Remove container-level event listeners during teardown before releasing viewer or scene resources.

## Resource Cleanup

Use the lightest cleanup method that matches ownership and lifecycle:

- Use `freeGPU()` to release GPU memory for an object whose source data the application can restore. CPU-backed splats can upload their samplers again. For a splat created by direct GPU upload, reparse the original asset after releasing its source textures.
- Use `freeAllGpuResourceOwned()` when the object owns related GPU resources that should also be released. For example, `geometry.freeAllGpuResourceOwned()` releases the geometry GPU resource plus its attribute and index GPU resources; `drawable.freeAllGpuResourceOwned()` releases its materials, geometry, and drawable GPU resources.
- Use `destroy()` only when the object is permanently retired. Before calling `destroy()`, ensure the object is removed from the scene, no frame callback, async load, event listener, control, viewport, material, geometry, or app state will use it again, and it is not currently participating in a render/update pass.
- Prefer `freeGPU()` or `freeAllGpuResourceOwned()` for memory-pressure cleanup. Prefer `destroy()` for final teardown after references are severed.
- In component frameworks, cancel pending async work and stop animation/requestRender callbacks before releasing resources in unmount cleanup.

## Guardrails

- Do not hand-write code against private renderer internals or repository-only paths.
- Do not assume a server-side runtime; the viewer needs browser DOM and WebGL/WebGL2-capable canvas support.
- Do not construct `Splat` directly. Use loader and utility APIs.
- Do not register app DOM events on the engine canvas. Register on the container because the engine owns the canvas lifecycle and may replace it.
- Do not hold persistent references to the engine canvas. Read it only when needed, use it immediately, and release the reference.
- Do not call `destroy()` on resources that shared objects, cached data, render callbacks, or pending async work may still reference.
- Do not use `destroy()` as the default GPU-memory cleanup method. Use `freeGPU()` for the object's own GPU state, or `freeAllGpuResourceOwned()` when owned child resources should also release GPU state.
- Do not omit cleanup in component frameworks. In React, Vue, Svelte, or similar frameworks, dispose viewer-owned objects and cancel pending async work during unmount.
- Do not invent package exports. Check the LLM API index or installed package types.
