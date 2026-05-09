---
name: aholo-site
description: Work on Aholo Viewer Astro website and Playground surfaces under website/. Use for routes, layouts, components, page chrome, i18n UI copy, scoped CSS, client render runtime, Playground runner, preview canvas, inspector, presets, route-local Monaco, and URL parameters. Use aholo-examples for example content pairs.
---

# Aholo Site

Own the website shell and Playground integration. Do not own renderer source or example content pairs.

## Owns

- Astro routes, layouts, flat feature components, utilities, i18n, and site content under `website/`.
- Examples page chrome and preview layout, not `website/src/content/examples/*.json` or `*.ts`.
- Client render runtime under `website/src/client/`, camera/control integration, inspector, presets, and URL state.
- Playground shell in `website/src/components/PlaygroundShell.astro` and browser entry in `website/src/client/playground.ts`.
- Scoped styles: `theme.css`, `global.css`, `site.css`, `home.css`, `examples.css`, `docs.css`, `playground.css`.

## Boundaries

- Keep Monaco route-local through `website/src/components/PlaygroundShell.astro`; keep Playground browser entry in `website/src/client/playground.ts`.
- Preserve Playground URL params: `example` and `code`.
- Keep render runtime implementation in `website/src/client/render-runtime.ts` and runner contract in `website/src/client/render-runtime.d.ts`.
- Keep renderer type hints sourced from `packages/renderer/dist/index.d.ts`.
- Keep `website/src/content.config.ts` focused on Astro collections; manual pages are loaded through `website/src/utils/manual.ts`.
- Keep feature selectors out of `global.css`.
- Do not modify renderer public exports.
- Do not hand-edit `website/.generated/api/`.
- Use `aholo-examples` for example JSON/TS source pairs.

## Design

- Keep the site simple, refined, spacious, and tool-like.
- Keep homepage first-screen interactive renderer true fullscreen and resize the renderer after entering or exiting.

## Validate

```bash
pnpm.cmd check:website
```

Use `pnpm.cmd check` when renderer declarations or package output are involved.
