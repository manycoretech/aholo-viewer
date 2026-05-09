# Agent Guide

AI collaboration entrypoint. Keep context small, preserve user changes, and route work to the narrowest project skill.

## Modules

- Root: `pnpm` workspace orchestration, validation, release scripts.
- Website: `website/` Astro routes, layouts, flat feature components, client render runtime, docs pages, Playground, scoped styles.
- Examples: `website/src/content/examples/` paired example metadata and `RenderRuntime` runners.
- Renderer: `packages/renderer/` source and generated package output.
- Scripts: `scripts/` submodule prep, renderer build/clean, EGS types, API docs.
- Docs: `README.md`, `docs/`, manual pages, manual assets, AI collaboration guidance.
- External: `external/egs-core` submodule and `external/splat-transform` workspace package.
- Skills: `.codex/skills/` project-local collaboration rules.

## Skill Routing

- `aholo-examples`: example `<slug>.json` and `<slug>.ts` pairs, including `walk-demo`, metadata schema, runner lifecycle.
- `aholo-site`: website shell, page chrome, client render runtime, Playground integration, route-local Monaco, scoped CSS.
- `aholo-renderer`: renderer source, public API, declarations, generated dist flow, package/release validation.
- `aholo-docs`: README, AGENTS, architecture notes, AI guides, manual copy, bilingual docs.
- `frontend-design`: visual direction, responsive UI polish, layout/design review.
- `aholo-viewer`: only for cross-module work, scripts, generated docs/build flow, cleanup boundaries, or validation routing.

## Hard Boundaries

- Do not overwrite user changes. Start with `git status --short`.
- Keep edits inside the owning module unless the task explicitly spans modules.
- Do not hand-edit `external/egs-core`, `website/.generated/api/`, or `packages/renderer/dist/`.
- Do not delete `external/splat-transform`.
- Do not change `packages/renderer/src/index.ts` exports unless asked.
- Do not compare the renderer to third-party engines or frameworks unless asked.

## Website Boundaries

- Keep Monaco route-local through `website/src/components/PlaygroundShell.astro`; keep Playground browser entry in `website/src/client/playground.ts`.
- Preserve Playground URL params: `example` and `code`.
- Keep render runtime implementation in `website/src/client/render-runtime.ts` and runner contract in `website/src/client/render-runtime.d.ts`.
- Keep examples paired as `website/src/content/examples/<slug>.json` and `<slug>.ts`.
- Keep `website/src/content.config.ts` focused on Astro content collections; manual pages use `website/src/utils/manual.ts`.
- Keep top-level feature components flat in `website/src/components/`; keep only shared groups such as `docs/` and `site/` nested.
- Keep style ownership clear: `theme.css`, `global.css`, `site.css`, `home.css`, `examples.css`, `docs.css`, `playground.css`.
- Keep feature selectors out of `global.css`.
- Homepage first-screen interactive stage must remain true fullscreen: fixed positioning, `inset: 0`, `100dvh`/`100vw`, and renderer resize after state changes.

## Collaboration

- Reply to the user in Chinese.
- Use PowerShell with `pnpm.cmd` if `pnpm` or `pnpm.ps1` fails.
- If port `4321` is already in use, assume the user's dev server is running and use it directly.
- Read `docs/architecture.md` only for package boundaries, generated API docs, build flow, or directory structure.
- Keep Chinese copy technical and concise. Keep English copy in SDK documentation style.
- For manual pages and UI translations, treat Chinese wording as the source of truth.
- Use actual public renderer exports in docs and examples.
- End handoffs with changed files, validation, skipped checks, and risks.

## Validation

- Website/layout/manual/example runtime: `pnpm.cmd check:website`.
- Content-only example metadata: `pnpm.cmd check:content`.
- Renderer/API/release work: `pnpm.cmd check`.
- Package/release changes: `pnpm.cmd build`.
- Docs-only repo notes: path/reference scan is enough unless imported by the site.
- If esbuild reports `Cannot read directory "../../../.."`, rerun the same command with approved workspace access.
