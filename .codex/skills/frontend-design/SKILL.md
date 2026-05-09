---
name: frontend-design
description: Design and polish Aholo Viewer frontend interfaces with production-grade visual quality. Use for website UI direction, Astro page/component styling, responsive layout, visual refinement, and frontend design reviews in this repository.
---

# Frontend Design

Use this local skill for Aholo Viewer website and Playground visual design. Keep implementation consistent with the existing Astro site and scoped CSS architecture.

## Direction

- Audience: frontend engineers, SDK docs readers, and product-demo evaluators.
- Product: high-performance 3DGS rendering for web applications.
- Tone: simple, refined, spacious, comfortable, technical, and tool-like.
- Avoid generic AI aesthetics, broad marketing visuals, and overdecorated layouts.

## Rules

- Respect existing style layers: `theme.css`, `global.css`, `site.css`, `home.css`, `examples.css`, `docs.css`, `playground.css`.
- Keep feature-specific selectors out of `global.css`.
- Use restrained color, typography, spacing, and motion that fit SDK documentation and technical tooling.
- Do not make marketing-style landing sections unless the user explicitly asks.
- Ensure text, controls, canvas surfaces, and panels do not overlap on mobile or desktop.
- Use icons for compact controls when available, and keep repeated tool UI stable in size.

## Validate

```bash
pnpm.cmd check:website
```
