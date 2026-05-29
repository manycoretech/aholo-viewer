#!/usr/bin/env node
/**
 * Generates AI-friendly English markdown copies of the built documentation
 * under website/dist/llm/. Reads cleanest sources where possible (manual
 * markdown, example .ts/.json) and converts generated API HTML fragments
 * to markdown.
 *
 * Output layout:
 *   website/dist/llm/
 *     index.md
 *     README.md
 *     manual/{slug}.md, index.md
 *     api/{category}/{folder}/{name}.md, index.md
 *     examples/{slug}.md, index.md
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { workspaceRoot } from './package-utils.mjs';

const LOCALE = 'en-US';
const manualSourceRoot = resolve(workspaceRoot, 'website/src/content/manual');
const examplesSourceRoot = resolve(workspaceRoot, 'website/src/content/examples');
const generatedApiRoot = resolve(workspaceRoot, 'website/.generated/api');
const llmRoot = resolve(workspaceRoot, 'website/dist/llm');

await rm(llmRoot, { recursive: true, force: true });
await mkdir(llmRoot, { recursive: true });

const apiManifest = await loadApiManifest();
const manualEntries = await emitManual();
const apiEntries = await emitApi();
const exampleEntries = await emitExamples();

await writeFile(resolve(llmRoot, 'index.md'), renderRootIndex(manualEntries, apiEntries, exampleEntries));
await writeFile(resolve(llmRoot, 'README.md'), renderReadme());

console.log(
    `[llm-docs] Wrote markdown corpus: ` +
        `${manualEntries.length} manual, ${apiEntries.length} api, ${exampleEntries.length} example files.`,
);

// ---------- Manual ----------

async function emitManual() {
    const sourceDir = resolve(manualSourceRoot, LOCALE);

    if (!existsSync(sourceDir)) {
        return [];
    }

    const files = (await readdir(sourceDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && extname(entry.name) === '.md')
        .map(entry => entry.name);

    const entries = [];

    for (const fileName of files) {
        const filePath = resolve(sourceDir, fileName);
        const source = await readFile(filePath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(source);
        const slug = fileName.replace(/\.md$/, '');
        const title = stringField(frontmatter, 'title') ?? slug;
        const description = stringField(frontmatter, 'description') ?? '';
        const order = numberField(frontmatter, 'order') ?? 0;
        const rewrittenBody = rewriteManualBody(body);
        const markdown = renderManualMarkdown(title, description, rewrittenBody);

        await writeMarkdown(resolve(llmRoot, 'manual', `${slug}.md`), markdown);
        entries.push({ slug, title, description, order });
    }

    entries.sort((left, right) => left.order - right.order || left.slug.localeCompare(right.slug));

    await writeMarkdown(resolve(llmRoot, 'manual', 'index.md'), renderManualIndex(entries));

    return entries;
}

function renderManualMarkdown(title, description, body) {
    const sections = [`# ${title}`];

    if (description && description !== title) {
        sections.push(`> ${description}`);
    }

    sections.push(body.trim());

    return `${sections.join('\n\n')}\n`;
}

function renderManualIndex(entries) {
    const lines = [
        '# Manual',
        '',
        '> Full product manual. Read `getting-started.md` then `basic-concepts.md` before using the SDK.',
        '',
    ];

    for (const entry of entries) {
        const description = entry.description && entry.description !== entry.title ? ` — ${entry.description}` : '';
        lines.push(`- [${entry.title}](./${entry.slug}.md)${description}`);
    }

    return `${lines.join('\n')}\n`;
}

function rewriteManualBody(body) {
    const withRewrittenLinks = body.replace(
        /(^|[^!])(\[[^\]]*]\()([^)\s]+)([^)]*\))/g,
        (match, prefix, opening, href, closing) => {
            const rewritten = rewriteManualHref(href);
            return rewritten ? `${prefix}${opening}${rewritten}${closing}` : match;
        },
    );

    return withRewrittenLinks.replace(/(!\[[^\]]*]\()([^)\s]+)([^)]*\))/g, (match, opening, href, closing) => {
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) {
            return match;
        }

        const sourceLocation = `../../src/content/manual/${LOCALE}/${href.replace(/^\.?\/+/, '')}`;
        return `${opening}${sourceLocation}${closing}`;
    });
}

function rewriteManualHref(href) {
    if (!href) {
        return undefined;
    }

    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) {
        return undefined;
    }

    if (href.startsWith('api:')) {
        const symbol = href
            .slice('api:'.length)
            .replace(/[#?].*$/, '')
            .trim();
        const entry = findApiEntryBySymbol(symbol);
        return entry ? `../api/${entry.slug}.md` : undefined;
    }

    if (href.startsWith('/')) {
        return undefined;
    }

    // Rewrite cross-section relative links like `../../examples/foo/` → `../examples/foo.md`.
    const crossSection = href.match(/^\.\.\/\.\.\/(examples|api|manual)\/([^?#]*?)\/?([?#].*)?$/);

    if (crossSection) {
        const [, section, slug, trailing = ''] = crossSection;
        const cleanSlug = slug.replace(/\/$/, '');
        return `../${section}/${cleanSlug === '' ? 'index' : cleanSlug}.md${trailing}`;
    }

    if (href.endsWith('.md') || /\.md[?#]/.test(href)) {
        return href;
    }

    return undefined;
}

// ---------- API ----------

async function emitApi() {
    if (!apiManifest) {
        return [];
    }

    const apiLocaleDir = resolve(generatedApiRoot, LOCALE);

    if (!existsSync(apiLocaleDir)) {
        return [];
    }

    const entries = [];

    for (const entry of apiManifest.entries ?? []) {
        const sourcePath = resolve(apiLocaleDir, `${entry.slug}.html`);

        if (!existsSync(sourcePath)) {
            continue;
        }

        const html = await readFile(sourcePath, 'utf8');
        const body = htmlToMarkdown(html, {
            rewriteLink: href => rewriteApiHref(href, entry.slug),
        });
        const heading = entry.signature
            ? `# ${entry.title}\n\n\`\`\`ts\n${entry.signature}\n\`\`\``
            : `# ${entry.title}`;
        const meta = renderApiMeta(entry);
        const description = entry.description ? `> ${entry.description}\n\n` : '';
        const markdown = `${heading}\n\n${meta}${description}${body.trim()}\n`;

        await writeMarkdown(resolve(llmRoot, 'api', `${entry.slug}.md`), markdown);
        entries.push(entry);
    }

    await writeMarkdown(resolve(llmRoot, 'api', 'index.md'), renderApiIndex(entries));

    return entries;
}

function renderApiMeta(entry) {
    const segments = [];

    if (entry.categoryLabel) {
        segments.push(`Category: \`${entry.categoryLabel}\``);
    }

    if (entry.namespaceLabel && entry.namespaceLabel !== entry.categoryLabel) {
        segments.push(`Namespace: \`${entry.namespaceLabel}\``);
    }

    if (entry.kindLabel) {
        segments.push(`Kind: \`${entry.kindLabel}\``);
    }

    return segments.length ? `${segments.join(' · ')}\n\n` : '';
}

function renderApiIndex(entries) {
    const grouped = new Map();

    for (const entry of entries) {
        const key = `${entry.categoryLabel ?? 'Misc'}::${entry.namespaceLabel ?? entry.categoryLabel ?? 'Misc'}`;

        if (!grouped.has(key)) {
            grouped.set(key, {
                categoryLabel: entry.categoryLabel ?? 'Misc',
                namespaceLabel: entry.namespaceLabel ?? entry.categoryLabel ?? 'Misc',
                entries: [],
            });
        }

        grouped.get(key).entries.push(entry);
    }

    const lines = [
        '# API Reference',
        '',
        '> Generated from TypeDoc, grouped by namespace. Each `.md` file corresponds to one exported symbol.',
        '',
    ];

    let lastCategory;

    for (const group of grouped.values()) {
        if (group.categoryLabel !== lastCategory) {
            lines.push('', `## ${group.categoryLabel}`, '');
            lastCategory = group.categoryLabel;
        }

        if (group.namespaceLabel && group.namespaceLabel !== group.categoryLabel) {
            lines.push(`### ${group.namespaceLabel}`, '');
        }

        for (const entry of group.entries) {
            lines.push(`- [${entry.title}](./${entry.slug}.md) — ${entry.kindLabel}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

function rewriteApiHref(href, currentSlug) {
    if (!href) {
        return undefined;
    }

    const localePrefix = `/${LOCALE}/api/`;

    if (href.startsWith(localePrefix)) {
        const [pathname, hash = ''] = splitHash(href.slice(localePrefix.length));
        const targetSlug = pathname.replace(/\/$/, '');
        if (!targetSlug) {
            return `./index.md${hash}`;
        }
        return relativeMdHref(currentSlug, targetSlug) + hash;
    }

    if (href.startsWith('http://') || href.startsWith('https://')) {
        return href;
    }

    return undefined;
}

function splitHash(value) {
    const index = value.indexOf('#');
    if (index === -1) {
        return [value, ''];
    }
    return [value.slice(0, index), value.slice(index)];
}

function relativeMdHref(fromSlug, toSlug) {
    const fromParts = fromSlug.split('/');
    const toParts = toSlug.split('/');
    fromParts.pop();

    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
        common += 1;
    }

    const ups = fromParts.length - common;
    const downs = toParts.slice(common);
    const prefix = ups === 0 ? './' : '../'.repeat(ups);

    return `${prefix}${downs.join('/')}.md`;
}

function findApiEntryBySymbol(symbol) {
    if (!apiManifest) {
        return undefined;
    }

    const entries = apiManifest.entries ?? [];
    const direct = entries.find(entry => entry.title === symbol);

    if (direct) {
        return direct;
    }

    const dotted = symbol.split('.');

    if (dotted.length === 2) {
        return entries.find(entry => entry.namespace === dotted[0] && entry.title === dotted[1]);
    }

    return undefined;
}

async function loadApiManifest() {
    const manifestPath = resolve(generatedApiRoot, 'manifest.ts');

    if (!existsSync(manifestPath)) {
        return undefined;
    }

    const source = await readFile(manifestPath, 'utf8');
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
        return undefined;
    }

    return JSON.parse(source.slice(start, end + 1));
}

// ---------- Examples ----------

async function emitExamples() {
    if (!existsSync(examplesSourceRoot)) {
        return [];
    }

    const entries = await readdir(examplesSourceRoot, { withFileTypes: true });
    const slugs = entries
        .filter(entry => entry.isFile() && extname(entry.name) === '.json')
        .map(entry => entry.name.replace(/\.json$/, ''));

    const items = [];

    for (const slug of slugs) {
        const jsonPath = resolve(examplesSourceRoot, `${slug}.json`);
        const codePath = resolve(examplesSourceRoot, `${slug}.ts`);
        const meta = JSON.parse(await readFile(jsonPath, 'utf8'));
        const code = existsSync(codePath) ? await readFile(codePath, 'utf8') : '';
        const title = meta?.title?.[LOCALE] ?? meta?.title?.['en-US'] ?? slug;
        const tags = Array.isArray(meta?.tags) ? meta.tags : [];
        const order = typeof meta?.order === 'number' ? meta.order : Number.POSITIVE_INFINITY;

        const markdown = renderExampleMarkdown({ slug, title, tags, code });

        await writeMarkdown(resolve(llmRoot, 'examples', `${slug}.md`), markdown);
        items.push({ slug, title, tags, order });
    }

    items.sort((left, right) => left.order - right.order || left.slug.localeCompare(right.slug));

    await writeMarkdown(resolve(llmRoot, 'examples', 'index.md'), renderExamplesIndex(items));

    return items;
}

function renderExampleMarkdown({ slug, title, tags, code }) {
    const tagLine = tags.length ? `Tags: ${tags.map(tag => `\`${tag}\``).join(', ')}\n\n` : '';
    const sourceHint = `Source: \`website/src/content/examples/${slug}.ts\`\n\n`;
    const liveUrl = `/${LOCALE}/examples/${slug}/`;
    const codeBlock = code.trim() ? `\`\`\`ts\n${code.trim()}\n\`\`\`\n` : '_No code attached._\n';

    return `# ${title}\n\n${tagLine}${sourceHint}Live page: \`${liveUrl}\`\n\n${codeBlock}`;
}

function renderExamplesIndex(items) {
    const lines = [
        '# Examples',
        '',
        '> Each example demonstrates one SDK capability. The markdown file contains the original TypeScript source.',
        '',
    ];

    for (const item of items) {
        const tagSuffix = item.tags.length ? ` — tags: ${item.tags.join(', ')}` : '';
        lines.push(`- [${item.title}](./${item.slug}.md)${tagSuffix}`);
    }

    return `${lines.join('\n')}\n`;
}

// ---------- Root index ----------

function renderRootIndex(manual, api, examples) {
    const lines = [
        '# Aholo Viewer — AI-Friendly Documentation',
        '',
        'This directory is the machine-readable corpus of the Aholo Viewer docs. ',
        'It is regenerated on every `pnpm build` from the same sources that produce the public website.',
        '',
        '## Entry Points',
        '',
        `- [Manual](./manual/index.md) — ${manual.length} pages`,
        `- [API Reference](./api/index.md) — ${api.length} symbols`,
        `- [Examples](./examples/index.md) — ${examples.length} runnable demos`,
        '',
        '## Recommended Reading Order',
        '',
        '1. `manual/getting-started.md` — install and bootstrap a viewer in minutes.',
        '2. `manual/basic-concepts.md` — mental model for scene, camera, renderer.',
        '3. Browse `api/` and `examples/` on demand.',
        '',
        '## Directory Layout',
        '',
        '```',
        'llm/',
        '  index.md       # this file',
        '  manual/        # user manual (markdown)',
        '  api/           # API reference (converted from TypeDoc HTML)',
        '  examples/      # runnable examples with TypeScript source',
        '```',
        '',
    ];

    return `${lines.join('\n')}\n`;
}

function renderReadme() {
    return [
        '# /llm — AI-friendly docs',
        '',
        'This folder is generated by `scripts/generate-llm-docs.mjs` as part of `pnpm build`.',
        '',
        'It mirrors the human-facing site under `/{locale}/manual`, `/{locale}/api`, `/{locale}/examples`',
        'but as plain English markdown, which is easier for automated coding agents to parse.',
        '',
        'Do not edit files here directly — they will be regenerated on every build.',
        '',
    ].join('\n');
}

// ---------- Utilities ----------

async function writeMarkdown(filePath, content) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}

function parseFrontmatter(source) {
    if (!source.startsWith('---')) {
        return { frontmatter: {}, body: source };
    }

    const closing = source.indexOf('\n---', 3);

    if (closing === -1) {
        return { frontmatter: {}, body: source };
    }

    const rawFrontmatter = source.slice(3, closing).trim();
    const body = source.slice(closing + 4).replace(/^\r?\n/, '');
    const frontmatter = {};

    for (const line of rawFrontmatter.split(/\r?\n/)) {
        const match = line.match(/^([\w-]+)\s*:\s*(.*)$/);

        if (!match) {
            continue;
        }

        const [, key, rawValue] = match;
        const trimmed = rawValue.trim().replace(/^['"](.*)['"]$/, '$1');

        frontmatter[key] = trimmed;
    }

    return { frontmatter, body };
}

function stringField(frontmatter, key) {
    const value = frontmatter[key];

    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed === '' ? undefined : trimmed;
}

function numberField(frontmatter, key) {
    const value = Number(frontmatter[key]);

    return Number.isFinite(value) ? value : undefined;
}

// ---------- HTML → Markdown ----------

function htmlToMarkdown(html, { rewriteLink } = {}) {
    let working = html;

    working = working.replace(/<a\b[^>]*class=(["'])[^"']*\btsd-anchor-icon\b[^"']*\1[^>]*>[\s\S]*?<\/a>/g, '');
    working = working.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
    working = working.replace(/<wbr\s*\/?>/g, '');

    working = working.replace(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/g, (_match, attrs, inner) => {
        const langMatch = attrs.match(/class=(["'])([^"']*)\1/);
        const langClass = langMatch?.[2] ?? '';
        const lang = langClass.match(/language-([\w-]+)/)?.[1] ?? '';
        const text = decodeHtmlEntities(stripTags(inner));
        return `\n\n\`\`\`${lang}\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    });

    working = working.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g, (_match, inner) => {
        const text = decodeHtmlEntities(stripTags(inner));
        return `\n\n\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    });

    working = working.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/g, (_match, inner) => {
        const text = decodeHtmlEntities(stripTags(inner)).replace(/`/g, '\\`');
        return `\`${text}\``;
    });

    working = working.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
        const text = decodeHtmlEntities(stripTags(inner)).trim();
        if (!text) return '';
        return `\n\n${'#'.repeat(Number(level))} ${text}\n\n`;
    });

    working = working.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/g, (_match, attrs, inner) => {
        const hrefMatch = attrs.match(/href=(["'])([^"']*)\1/);
        const text = decodeHtmlEntities(stripTags(inner)).trim();

        if (!hrefMatch) {
            return text;
        }

        const rawHref = decodeHtmlEntities(hrefMatch[2]);
        const finalHref = rewriteLink ? (rewriteLink(rawHref) ?? rawHref) : rawHref;

        if (!text) {
            return finalHref;
        }

        return `[${text}](${finalHref})`;
    });

    working = working.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/g, (_match, inner) => {
        return `**${decodeHtmlEntities(stripTags(inner)).trim()}**`;
    });
    working = working.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/g, (_match, inner) => {
        return `*${decodeHtmlEntities(stripTags(inner)).trim()}*`;
    });

    working = working.replace(/<br\s*\/?>(\s*)/g, '\n$1');

    working = working.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/g, (_match, tag, inner) => {
        const isOrdered = tag === 'ol';
        const items = [];
        let counter = 1;

        inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/g, (_full, itemInner) => {
            const itemText = collapseWhitespace(decodeHtmlEntities(stripTags(itemInner)));
            if (itemText) {
                const bullet = isOrdered ? `${counter}.` : '-';
                items.push(`${bullet} ${itemText}`);
                counter += 1;
            }
            return '';
        });

        return `\n\n${items.join('\n')}\n\n`;
    });

    working = working.replace(/<(p|section|article|div|details|summary)\b[^>]*>/g, '\n\n');
    working = working.replace(/<\/(p|section|article|div|details|summary)>/g, '\n\n');

    working = stripTags(working);
    working = decodeHtmlEntities(working);
    working = working.replace(/[ \t]+\n/g, '\n');
    working = working.replace(/\n{3,}/g, '\n\n');

    return working.trim();
}

function stripTags(value) {
    return value.replace(/<[^>]+>/g, '');
}

function collapseWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&amp;/g, '&');
}
