---
name: aholo-docs
description: Work on Aholo Viewer documentation and product writing. Use for README, AGENTS.md, docs/architecture.md, docs/ai/vibe-coding-guide.md, manual pages, API documentation flow, bilingual copy, release-readiness notes, and AI collaboration guidance.
---

# Aholo Docs

Use `docs/ai/vibe-coding-guide.md` as the writing source of truth.

## Core Rules

- Product: high-performance 3DGS rendering for web applications.
- Audience: frontend engineers, SDK docs readers, product-demo evaluators.
- Chinese copy: technical and concise.
- English copy: SDK documentation style.
- Keep zh-CN and en-US manual pages structurally parallel.
- Treat `website/src/content/manual/` as filesystem Markdown content, not an Astro content collection.
- Keep manual assets under `website/src/content/manual/assets/` and use local relative image references in manual Markdown.
- Use real public renderer exports in docs and examples.
- Do not document internal renderer symbols without user direction.

## Key Files

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/ai/vibe-coding-guide.md`
- `website/src/content/manual/{zh-CN,en-US}/`
- `website/src/utils/manual.ts`
- `website/src/utils/manual-assets.js`

## Validate

Docs-only notes need path/reference scans. Manual or website-imported docs need:

```bash
pnpm.cmd check:website
```
