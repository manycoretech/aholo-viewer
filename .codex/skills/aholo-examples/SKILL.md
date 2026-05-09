---
name: aholo-examples
description: Work on Aholo Viewer example content pairs under website/src/content/examples. Use for creating, modifying, reviewing, or validating example *.json metadata and *.ts runners, Playground presets derived from examples, home-only example runners, config panels, async loading/caching, cleanup, and source shown in Playground.
---

# Aholo Examples

Own example content.

## Owns

- `website/src/content/examples/<slug>.json`
- `website/src/content/examples/<slug>.ts`
- Content metadata, `RenderRuntime` runner lifecycle, async loading, IndexedDB caching, config panels, and cleanup.
- Source code that appears as a Playground preset.

## References

- Use `splatting-basic`, `splatting-lod-stream`, `3d-buffer-geometry`, `3d-point-light`, and `home-interaction` as normal references.
- Read `website/src/content.config.ts` for examples metadata schema.
- Read `website/src/client/render-runtime.d.ts` for runner runtime.
- Read `website/src/utils/examples.ts` when changing surfaces, ordering, presets, or default examples.

## Contracts

- Keep JSON and TS files paired by the same slug.
- Use `surfaces` only when deviating from the default `["examples", "playground"]`; use `["home"]` for home-only runners. Do not repeat surface names.
- Keep `order` nonnegative and integral, `tags` nonempty, and `accent` as a six-digit hex color.
- Keep Chinese titles technical and concise; keep English titles in SDK documentation style.
- Import renderer APIs from `@manycore/aholo-viewer` and use actual public exports.
- Export an async default runner that accepts `RenderRuntime`.
- Check `signal.aborted` after async work and throw `AbortError` with a specific message.
- Use `loading.show()` before async fetch/decode and `loading.hide()` only after the scene is ready.
- Return a cleanup function that removes scene objects and destroys created GPU resources.

## Boundaries

- Do not change renderer public exports. Surface the need instead.
- Do not edit `packages/renderer/dist/` or `website/.generated/api/`.
- Use `aholo-site` for examples page chrome, Playground shell, client render runtime, or style work.

## Validate

- Metadata-only: `pnpm.cmd check:content`.
- Runner or website integration: `pnpm.cmd check:website`.
- Renderer API/package interaction: `pnpm.cmd check`.
