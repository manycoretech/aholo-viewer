---
name: aholo-renderer
description: Work on the @manycore/aholo-viewer package. Use only when the user explicitly asks for renderer source, package build, public exports, JSDoc/API docs, generated declaration flow, renderer dist, packing, or release validation.
---

# Aholo Renderer

Work inside `packages/renderer/` and renderer-related scripts.

## Core Rules

- Renderer public API exports are user-owned.
- Do not change `packages/renderer/src/index.ts` exports unless explicitly asked.
- Do not hand-edit `external/egs-core` or `packages/renderer/dist/`.
- Do not delete `external/splat-transform`; it is a required workspace package.
- Add concise JSDoc only for user-approved public API work.
- If public API changes, regenerate docs through normal commands.

## Validate

```bash
pnpm.cmd check:renderer
pnpm.cmd build:renderer
```
