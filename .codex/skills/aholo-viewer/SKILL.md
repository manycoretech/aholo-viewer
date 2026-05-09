---
name: aholo-viewer
description: Coordinate Aholo Viewer monorepo work. Use for cross-module tasks, workspace scripts, generated docs/build flow, validation routing, cleanup boundaries, or when work must be routed between examples, site, renderer, docs, and frontend design skills.
---

# Aholo Viewer

Read `AGENTS.md` first. Use this skill only when the task spans modules or needs repo-level validation/routing.

## Route

- `aholo-examples`: example content pairs under `website/src/content/examples/`, including `walk-demo`.
- `aholo-site`: Astro website shell, examples page chrome, docs UI, Playground, Monaco, client render runtime.
- `aholo-renderer`: renderer package, public API, declarations, build, dist, release checks.
- `aholo-docs`: README, AGENTS, architecture notes, manual copy/assets, AI guides, release notes.
- `frontend-design`: website visual direction, responsive polish, UI review.

## Boundaries

- Keep website work in `website/`, renderer work in `packages/renderer/`, shared automation in `scripts/`.
- Keep examples as paired metadata/runners and manual as filesystem Markdown loaded through website utilities.
- Do not hand-edit `external/egs-core`, `website/.generated/api/`, or generated `dist/`.
- Do not delete `external/splat-transform`.
- Do not change renderer public exports unless explicitly asked.

## Validate

```bash
pnpm.cmd check:website
pnpm.cmd check:renderer
pnpm.cmd check
pnpm.cmd build
```

If esbuild reports `Cannot read directory "../../../.."`, rerun the same command with approved workspace access.
