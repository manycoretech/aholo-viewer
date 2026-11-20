# Claude Instructions: Use Aholo Viewer

Use these instructions when Claude is helping a user integrate the public `@manycore/aholo-viewer` npm package into a browser application.

## Activation

Apply this guidance when the user asks Claude to install, bootstrap, debug, or extend an app that uses `@manycore/aholo-viewer`, especially for:

- 3D Gaussian Splatting (3DGS) rendering.
- Mesh rendering with `BufferGeometry`, `Mesh`, lights, and materials.
- Viewer setup, camera setup, scene composition, render-loop wiring, or cleanup.
- React, Vue, Svelte, Vite, or plain TypeScript browser integrations.

## Read First

Before writing non-trivial code, read the AI-facing docs listed by `https://aholojs.dev/llms.txt`.

Preferred reading order:

1. `https://aholojs.dev/llm/manual/getting-started.md`
2. `https://aholojs.dev/llm/manual/basic-concepts.md`
3. `https://aholojs.dev/llm/api/index.md`
4. `https://aholojs.dev/llm/examples/index.md`

Use the Markdown docs instead of scraping rendered HTML.

## Implementation Rules

- Import only public exports from `@manycore/aholo-viewer`; never import internal `@qunhe/*` packages.
- Create a stable application-owned container before calling `createViewer(...)`.
- Attach DOM event listeners to the container or another app-owned element, not to the engine canvas.
- Do not persistently store the engine canvas. If canvas access is unavoidable, read it only at the point of use and discard the reference immediately.
- Use `PerspectiveCamera` or `OrthographicCamera`, then call `viewer.setCamera(camera)`.
- Add objects to `viewer.getScene()`.
- Configure the pipeline with `setViewerConfig(viewer, { pipeline: ... })`.
- Trigger rendering with `viewer.render()` or schedule rendering through `viewer.requestRenderHandler`.
- Do not construct `Splat` directly; load splat data with `SplatLoader` and create renderable splats with `SplatUtils.createSplat(...)`.

## Cleanup Rules

- Stop render loops, event listeners, controls, and pending async work before releasing resources.
- Use `freeGPU()` to release an object's own GPU resources. CPU-backed splats can upload again. A splat whose source was uploaded directly to the GPU must be reloaded after its source textures are freed.
- Use `freeAllGpuResourceOwned()` when owned child resources should also release GPU state. For example, `geometry.freeAllGpuResourceOwned()` also releases attribute and index GPU resources.
- Use `destroy()` only for final teardown after the object is detached from the scene and no callback, async task, viewport, material, geometry, or app state can use it again.

## Output Style

- Prefer concise TypeScript examples over long explanations.
- For full setup steps, link to `https://aholojs.dev/en-US/manual/getting-started/` instead of duplicating the complete tutorial.
- Confirm less common exports against `https://aholojs.dev/llm/api/index.md` before using them.
