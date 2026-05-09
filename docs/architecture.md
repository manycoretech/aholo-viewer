# Project Architecture

## Overview

Aholo Viewer is split into two main products:

- `@manycore/aholo-viewer`: the TypeScript renderer package.
- `@manycore/aholo-viewer-website`: the Astro documentation and playground website.

The root package coordinates build, check, API generation, and packaging through pnpm workspace scripts.

## Workspace Layout

```text
./
  package.json
  pnpm-workspace.yaml
  AGENTS.md

  website/
    package.json
    astro.config.mjs
    .generated/
      api/
    src/
      components/
      config/
      content/
      i18n/
      layouts/
      pages/
      playground/
      styles/
      utils/

  packages/
    renderer/
      package.json
      tsconfig.json
      src/
      dist/

  scripts/
    build-package.mjs
    check-content.mjs
    clean-package.mjs
    ensure-submodules.mjs
    package-utils.mjs
    prepare-egs-types.mjs
    generate-api-docs.mjs

  docs/
    architecture.md
    ai/
      vibe-coding-guide.md

  external/
    egs-core/
    splat-transform/
```

## Structural Roles

- Root package: workspace entry point for dependency preparation, renderer build, API generation, website checks, and release packaging.
- `packages/renderer/`: public renderer package source. `src/index.ts` is the public API barrel; package-local files hold math, events, animation, loader, and utility namespaces.
- `website/`: Astro application for home, manual, API reference, examples, and Playground. Route modules live under `pages/`; shared UI lives under `layouts/` and `components/`; route-independent data helpers live under `utils/`.
- `website/src/playground/`: route-local Playground runtime, Monaco integration, renderer adapter, camera control, and example-facing types.
- `website/src/content/`: manual pages, manual assets, and paired example metadata/source files.
- `scripts/`: shared Node automation for submodule readiness, EGS declarations, renderer packaging, API HTML generation, content validation, and clean tasks.
- `external/egs-core`: upstream submodule consumed by workspace packages and renderer packaging scripts.
- `external/splat-transform`: required workspace package used by the manual and examples workflow.

## Dependency Direction

```text
external/egs-core workspace packages
  -> scripts/prepare-egs-types.mjs
  -> renderer type checks and declaration bundling

packages/renderer/src/index.ts
  -> scripts/build-package.mjs
  -> packages/renderer/dist
  -> website Playground runtime, examples, and type hints

packages/renderer/src/index.ts
  -> scripts/generate-api-docs.mjs
  -> website/.generated/api/
  -> website pages
```

`website/` may depend on `@manycore/aholo-viewer` through the workspace package. The renderer package should not depend on the website. Website `dev`, `build`, and `check` first run the renderer build, then regenerate API HTML and manifest data.

`external/egs-core` is an upstream dependency submodule. `external/splat-transform` is a required workspace package. Scripts may read external sources and generate dependency outputs needed for local builds, but repository changes should not hand-edit upstream code unless a task explicitly targets that package.

## Root Command Graph

Root scripts keep the workspace build order explicit:

```text
pnpm dev
  -> .egs:types
  -> .renderer:build
  -> .docs:api
  -> check:content
  -> .site:dev

pnpm check
  -> .egs:types
  -> .renderer:check
  -> .renderer:build
  -> .docs:api
  -> check:content
  -> .site:check

pnpm build
  -> build:website
  -> .egs:types
  -> .renderer:build
  -> .docs:api
  -> .site:build
```

Targeted commands preserve the same boundaries: `check:renderer` prepares EGS types and runs the renderer type check, `check:website` prepares renderer/API outputs before Astro checks, and `docs:api` prepares EGS types before generating API HTML and manifest data.

## API Documentation Flow

1. Export public API from `packages/renderer/src/index.ts`.
2. Add concise JSDoc comments to public classes, functions, interfaces, and types.
3. Run `pnpm docs:api`.
4. The generated HTML fragments are written to the ignored local directory `website/.generated/api/{locale}/`.
5. A generated manifest beside those fragments drives API navigation, metadata, and table-of-contents data.
6. Astro API routes inline the TypeDoc HTML through the same DocsLayout flow used by the Manual.

Do not edit generated API HTML or manifest data by hand. `pnpm dev`, `pnpm build`, and `pnpm check` regenerate it before the website starts.

## Playground Flow

Examples live in the Astro content tree as paired metadata and source files:

```text
website/src/content/examples/
  basic-scene.json
  basic-scene.ts
```

The JSON file holds title, description, tags, accent, and order. The same-named TypeScript file is imported with `?raw`, passed to Monaco, and rendered in the Playground preview. Playground URLs support:

- `example`: selected preset slug.
- `code`: `lz-string` compressed editor source.

Resetting or switching presets clears custom `code` and returns to a clean example URL.

Playground type hints use `packages/renderer/dist/index.d.ts` through the workspace package. Do not add a second handwritten renderer declaration file under `website/src/playground/`.

## Content Validation

`pnpm check:content` scans manual pages, localized slugs, heading-depth parity, example source pairs, manual image references, orphan manual images, and internal-only documentation links. `pnpm check` and `pnpm check:website` run it before Astro checks.

## Website Style Layers

Website styles are split by responsibility so global changes stay small and feature surfaces remain easy to reason about:

```text
website/src/styles/
  theme.css       Design tokens: color, type, radii, shadows, layout widths
  global.css      Reset, base document styles, buttons, code, simple primitives
  site.css        Header, language/theme controls, listing-page shell
  home.css        Immersive home page and home-only interaction states
  examples.css    Examples list and example detail viewer chrome
  docs.css        Manual/API documentation layout and prose
  playground.css  Playground workspace, editor, preview, inspector chrome
```

`BaseLayout.astro` imports `theme.css`, `global.css`, and `site.css`. Feature pages import their own feature stylesheet only when needed. Avoid moving feature-specific selectors back into `global.css`.

The home page intentionally keeps a darker immersive style around the 3D canvas. Docs, API, examples, and Playground should stay lighter, more restrained, and tool-like.

## Build Outputs

- Website output: `website/dist/`
- Astro cache: `website/.astro/`
- Renderer output: `packages/renderer/dist/`
    - `index.js`: bundled public runtime.
    - `index.d.ts`: bundled public declarations, including upstream EGS types used by exported symbols.
    - `splat-worker.js`: bundled worker referenced by the runtime.

Root-level `dist/` and `.astro/` are stale and should not exist after the workspace split.

Ignored generated folders can be removed when a clean workspace is needed, but they should be produced by commands rather than hand-edited.

## Architecture Improvement Opportunities

1. Keep API navigation metadata generated from the same source as API HTML.

    `scripts/generate-api-docs.mjs` derives API namespaces, categories, entries, and TOC data from `packages/renderer/src/index.ts`. Keep any future API navigation changes in that generated manifest flow to avoid drift when public namespaces change.

2. Keep Playground integration behind the website adapter.

    `website/src/playground/renderer-adapter.ts` is the boundary between Monaco-transpiled examples, preview lifecycle, camera control, runtime stats, and `@manycore/aholo-viewer`. New preview behavior should stay in the website adapter unless it is a reusable renderer capability that belongs in `packages/renderer/`.

3. Make external EGS consumption more declarative.

    `prepare-egs-types.mjs` discovers and prepares EGS declarations, while `build-package.mjs` discovers runtime packages for esbuild aliases. A small allow-list or manifest for consumed EGS packages would make renderer packaging easier to audit and less dependent on directory traversal.

4. Treat generated output ownership as an architectural contract.

    `packages/renderer/dist/`, `website/.generated/api/`, and temporary API cache folders are command-owned. Any new generated surface should also have an owning script, stale-file cleanup, and a validation path before it is referenced by website routes or package exports.

5. Keep validation mapped to changed surfaces.

    Current checks are well split between renderer, website, content, and package build flows. As the site grows, add new validation to the narrowest existing command first, then wire it into `check` only when it protects a cross-area contract.
