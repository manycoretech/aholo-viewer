# @manycore/aholo-viewer

Renderer source package for Aholo Viewer.

From the repository root:

```bash
pnpm build:renderer
```

The package bundles the renderer runtime into `dist/index.js`, emits `dist/splat-worker.js`, and rolls the renderer plus upstream EGS declarations into a single `dist/index.d.ts` so consumers do not need the private `@qunhe/*` packages.

## Render Cloud SDK

`src/render-cloud/` is the Render Cloud client (REST + WebSocket). Import it as `RenderCloud` from `@manycore/aholo-viewer`.
