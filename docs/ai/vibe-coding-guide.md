# Vibe Coding Guide

Concise source for AI-assisted product writing, collaboration, and handoff rules.

## Work Loop

1. Read `AGENTS.md`.
2. Use the narrowest project skill for the task.
3. Read `docs/architecture.md` only for package boundaries, generated API docs, build flow, or directory structure.
4. Run `git status --short` before editing and preserve user changes.
5. When reading Chinese files, use `rg` or `Get-Content -Encoding utf8` to avoid PowerShell encoding ambiguity.

## Product Brief

- Audience: frontend engineers, SDK documentation readers, and product-demo evaluators.
- Positioning: high-performance 3D Gaussian Splatting (3DGS) rendering for web applications.
- Stage: preparing for public release.
- Visual direction: simple, refined, spacious, comfortable, technical.
- Primary manual-check browser: Chrome.

Core value:

- Focused renderer experience for web-based 3DGS scenes.
- High-performance 3DGS rendering.
- Surrounding 3DGS facilities: examples, preview, debugging, docs, and integration support.

## Skill Map

- `aholo-viewer`: cross-area work, repo cleanup, workspace scripts, and validation routing.
- `aholo-site`: Astro website, examples, docs UI, Playground, Monaco, runner, preview, presets, URL state.
- `aholo-renderer`: renderer package, public API, build, declarations, release checks.
- `aholo-docs`: docs, manual content, bilingual copy, AI collaboration notes.
- `frontend-design`: Aholo website visual direction, responsive styling, and UI polish.

## Writing Rules

- Keep copy concise, concrete, and tool-oriented.
- Avoid placeholders, broad marketing claims, and invented API names.
- Do not compare the renderer to third-party engines or frameworks unless explicitly asked.
- Use actual public renderer exports in snippets.
- Keep Chinese copy technical and concise.
- Keep English copy in an SDK documentation style.
- Keep zh-CN and en-US manual pages structurally parallel.

## Terms

```text
3D Gaussian Splatting (3DGS) / 3DGS
Mesh / 网格
Renderer / 渲染器
Scene / 场景
Camera / 相机
Material / 材质
Render loop / 渲染循环
Playground / Playground
Examples / 示例
Manual / 手册
API Reference / API 参考
```

## Non-Negotiables

- Renderer public API exports are user-owned.
- Do not modify `packages/renderer/src/index.ts` exports unless explicitly asked.
- Do not hand-edit `external/egs-core`, `website/.generated/api/`, or generated `dist` folders.
- Do not delete `external/splat-transform`; it is a required workspace package.
- Keep Monaco route-local.
- Keep examples as paired JSON metadata and TypeScript source files.

## Validation

```text
Site/Playground/style       pnpm.cmd check:website
Renderer/API/release        pnpm.cmd check
Package/release             pnpm.cmd build
Docs-only repo notes        path/reference scan unless imported by website
```

If esbuild cannot read the workspace in a sandboxed run, rerun the same command with approved workspace access.

For browser-based website checks, prefer an already running website service and reuse its URL/port before starting a new dev server.

## Handoff

End with:

- What changed.
- Validation result.
- Skipped checks, risks, or assumptions.
- Follow-up suggestions only when useful.
