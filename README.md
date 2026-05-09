[![logo](./website/public/aholo-logo.svg)](https://aholojs.dev/)

# Aholo Viewer

Monorepo for the Aholo Viewer package and its documentation website.

## Structure

```text
aholo-viewer/
  AGENTS.md             Agent-facing project guide
  website/              Astro website: home, manual, examples, API docs, playground
  packages/renderer/    Renderer TypeScript source package
  scripts/              Shared build and documentation scripts
  docs/                 Architecture and AI collaboration notes
  external/             Required upstream and workspace dependency sources
  .codex/skills/        Project-local Codex skills
```

## Commands

Run workspace commands from the repository root:

```bash
pnpm install
pnpm dev
pnpm check
pnpm build
pnpm preview
```

Targeted root commands:

```bash
pnpm build:renderer
pnpm build:website
pnpm check:content
pnpm check:renderer
pnpm check:website
pnpm docs:api
```

## Project Docs

- `AGENTS.md`: quick guide for AI agents and future coding sessions
- `docs/architecture.md`: current workspace structure and dependency flow
- `docs/ai/vibe-coding-guide.md`: detailed guide for future AI-assisted changes, writing style, and handoffs
- `.codex/skills/`: local Codex skills split by repo area

## Codex Skills

Project-local skills live in `.codex/skills/`. Use `AGENTS.md` for the current skill map.

## External Source

`external/egs-core` is a required upstream submodule. `external/splat-transform` is a required workspace package and must stay in the repo. Treat upstream code under `external/` as read-only unless a task explicitly targets that package.

## API Docs

API docs are generated from `packages/renderer/src/index.ts` into an ignored local directory:

```text
website/.generated/api/
```

`pnpm dev`, `pnpm build`, and `pnpm check` regenerate them automatically. Run the generator directly when you want to refresh the local TypeDoc HTML and manifest without starting the site:

```bash
pnpm docs:api
```

## Content Checks

`pnpm check:content` validates manual locale parity, empty pages, example source pairs, manual image references, orphan manual images, and internal-only documentation links. It is also part of `pnpm check` and `pnpm check:website`.

## Playground URLs

The Playground keeps edited code in the URL with `lz-string`:

```text
/zh-CN/playground/?example=basic-scene&code=<compressed-source>
```

Opening a URL with `code` restores the editor content automatically.

Examples are stored in `website/src/content/examples/` as paired `<slug>.json` metadata and `<slug>.ts` source files. The same slug powers the Examples pages and Playground `example` query parameter.

## Useful Links

- [Discussions](https://github.com/manycoretech/aholo-viewer/discussions)
- [Official website](https://aholojs.dev/)
