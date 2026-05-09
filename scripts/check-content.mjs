import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
    formatWorkspacePath as formatPath,
    isInsideDir,
    listFiles,
    readJsonFile,
    readWebsiteLocales,
    statSafe,
    workspaceRoot,
} from './package-utils.mjs';

const root = workspaceRoot;
const websiteSource = resolve(root, 'website/src');
const manualRoot = join(websiteSource, 'content/manual');
const manualAssetRoot = join(manualRoot, 'assets');
const examplesRoot = join(websiteSource, 'content/examples');
const apiManifestPath = resolve(root, 'website/.generated/api/manifest.ts');
const bannedLinkPattern = /(?:https?:\/\/go\.|go\.\/|cf\.qunhequnhe|pages\/viewpage|display\/EGS)/i;
const imagePattern = /!\[[^\]]*]\(([^)]+)\)/g;
const markdownLinkPattern = /(^|[^!])\[[^\]]*]\(([^)]+)\)/g;
const htmlHrefPattern = /\bhref=(["'])([^"']+)\1/g;
const apiReferencePrefix = 'api:';

const errors = [];
const locales = readWebsiteLocales();
const defaultLocale = locales[0];
const apiEntriesBySymbol = createApiEntriesBySymbol(readApiManifest());

checkManualContent();
checkExamples();
checkManualImages();
checkManualLinks();
checkBannedLinks();

if (errors.length > 0) {
    console.error(`[content-check] Found ${errors.length} issue(s):`);
    for (const error of errors) {
        console.error(`- ${error}`);
    }
    process.exit(1);
}

console.log(`[content-check] OK: ${locales.length} locales, manual pages, examples, links, and assets are consistent.`);

function checkManualContent() {
    const manualByLocale = new Map();

    for (const locale of locales) {
        const localeDir = join(manualRoot, locale);

        if (!existsSync(localeDir)) {
            errors.push(`Missing manual locale directory: ${formatPath(localeDir)}`);
            continue;
        }

        const entries = new Map();
        for (const fileName of readdirSync(localeDir)
            .filter(file => file.endsWith('.md'))
            .sort()) {
            const slug = fileName.replace(/\.md$/, '');
            const filePath = join(localeDir, fileName);
            const content = readFileSync(filePath, 'utf8');
            const parsed = parseMarkdown(filePath, content);

            if (slug.includes('tranform')) {
                errors.push(`Manual slug contains misspelling "tranform": ${formatPath(filePath)}`);
            }

            if (content.trim() === '') {
                errors.push(`Manual page is empty: ${formatPath(filePath)}`);
            }

            if (!parsed.frontmatter.title) {
                errors.push(`Manual page is missing frontmatter title: ${formatPath(filePath)}`);
            }

            if (!parsed.frontmatter.description) {
                errors.push(`Manual page is missing frontmatter description: ${formatPath(filePath)}`);
            }

            if (!Number.isFinite(Number(parsed.frontmatter.order))) {
                errors.push(`Manual page is missing numeric frontmatter order: ${formatPath(filePath)}`);
            }

            if (parsed.body.trim() === '') {
                errors.push(`Manual page has no body content: ${formatPath(filePath)}`);
            }

            entries.set(slug, {
                filePath,
                headingSignature: getHeadingSignature(content),
            });
        }

        manualByLocale.set(locale, entries);
    }

    const baseEntries = manualByLocale.get(defaultLocale);
    if (!baseEntries) {
        return;
    }

    const baseSlugs = [...baseEntries.keys()].sort();

    for (const locale of locales.slice(1)) {
        const localizedEntries = manualByLocale.get(locale);
        if (!localizedEntries) {
            continue;
        }

        const localizedSlugs = [...localizedEntries.keys()].sort();
        const missing = baseSlugs.filter(slug => !localizedEntries.has(slug));
        const extra = localizedSlugs.filter(slug => !baseEntries.has(slug));

        for (const slug of missing) {
            errors.push(`Manual page "${slug}" exists in ${defaultLocale} but is missing in ${locale}.`);
        }

        for (const slug of extra) {
            errors.push(`Manual page "${slug}" exists in ${locale} but is missing in ${defaultLocale}.`);
        }

        for (const slug of baseSlugs.filter(item => localizedEntries.has(item))) {
            const baseSignature = baseEntries.get(slug).headingSignature;
            const localizedSignature = localizedEntries.get(slug).headingSignature;

            if (baseSignature !== localizedSignature) {
                errors.push(
                    `Manual heading depth structure differs for "${slug}" between ${defaultLocale} (${baseSignature}) and ${locale} (${localizedSignature}).`,
                );
            }
        }
    }
}

function checkBannedLinks() {
    const scanTargets = [
        join(root, 'README.md'),
        join(root, 'docs'),
        join(root, 'packages/renderer/README.md'),
        join(root, 'website/src/content'),
    ];

    for (const target of scanTargets) {
        const files = statSafe(target)?.isDirectory() ? listFiles(target) : [target];

        for (const filePath of files.filter(file => ['.md', '.mdx'].includes(extname(file).toLowerCase()))) {
            if (!existsSync(filePath)) {
                continue;
            }

            const content = readFileSync(filePath, 'utf8');

            if (bannedLinkPattern.test(content)) {
                errors.push(`Content contains an internal or invalid link: ${formatPath(filePath)}`);
            }
        }
    }
}

function checkExamples() {
    if (!existsSync(examplesRoot)) {
        errors.push(`Missing examples directory: ${formatPath(examplesRoot)}`);
        return;
    }

    const files = readdirSync(examplesRoot);
    const jsonSlugs = files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace(/\.json$/, ''))
        .sort();
    const sourceSlugs = files
        .filter(file => file.endsWith('.ts'))
        .map(file => file.replace(/\.ts$/, ''))
        .sort();

    for (const slug of jsonSlugs.filter(item => !sourceSlugs.includes(item))) {
        errors.push(`Example metadata is missing a TypeScript source file: ${slug}.json`);
    }

    for (const slug of sourceSlugs.filter(item => !jsonSlugs.includes(item))) {
        errors.push(`Example TypeScript source is missing JSON metadata: ${slug}.ts`);
    }

    for (const slug of jsonSlugs) {
        const filePath = join(examplesRoot, `${slug}.json`);
        const metadata = readJson(filePath);

        if (!metadata) {
            continue;
        }

        for (const locale of locales) {
            if (!metadata.title?.[locale]) {
                errors.push(`Example "${slug}" is missing title for ${locale}.`);
            }
        }
    }
}

function checkManualImages() {
    const usedImages = new Set();

    for (const filePath of listFiles(manualRoot).filter(file => file.endsWith('.md'))) {
        const content = readFileSync(filePath, 'utf8');

        for (const match of content.matchAll(imagePattern)) {
            const target = parseMarkdownTarget(match[1]);

            if (!target || isExternalReference(target.href)) {
                continue;
            }

            if (target.href.startsWith('/manual/')) {
                errors.push(
                    `Manual image should use a local relative path for editor previews: ${target.href} referenced by ${formatPath(filePath)}`,
                );
                continue;
            }

            if (!isLocalReference(target.href)) {
                continue;
            }

            const { pathname } = splitPathnameAndTrailing(target.href);
            const imagePath = resolve(dirname(filePath), decodeURIComponent(pathname));

            if (!isInsideDir(manualAssetRoot, imagePath)) {
                errors.push(
                    `Manual image must live under website/src/content/manual/assets: ${target.href} referenced by ${formatPath(filePath)}`,
                );
                continue;
            }

            usedImages.add(formatManualAssetPath(imagePath));

            if (!existsSync(imagePath)) {
                errors.push(`Manual image is missing: ${target.href} referenced by ${formatPath(filePath)}`);
                continue;
            }

            if (!isImageFile(imagePath)) {
                errors.push(
                    `Manual image reference is not an image file: ${target.href} referenced by ${formatPath(filePath)}`,
                );
            }
        }
    }

    for (const imagePath of listFiles(manualAssetRoot).filter(isImageFile)) {
        const normalized = formatManualAssetPath(imagePath);

        if (!usedImages.has(normalized)) {
            errors.push(`Manual image is not referenced by any manual page: ${normalized}`);
        }
    }
}

function checkManualLinks() {
    for (const filePath of listFiles(manualRoot).filter(file => file.endsWith('.md'))) {
        const content = readFileSync(filePath, 'utf8');

        for (const target of getManualLinkTargets(content)) {
            const parsed = parseMarkdownTarget(target);

            if (!parsed) {
                continue;
            }

            if (isApiReference(parsed.href)) {
                checkManualApiLink(parsed.href, target, filePath);
                continue;
            }

            if (!isLocalReference(parsed.href)) {
                continue;
            }

            const { pathname } = splitPathnameAndTrailing(parsed.href);

            if (extname(pathname).toLowerCase() !== '.md') {
                continue;
            }

            const linkedPath = resolve(dirname(filePath), decodeURIComponent(pathname));

            if (!isInsideDir(manualRoot, linkedPath)) {
                errors.push(
                    `Manual Markdown link must point to a manual page: ${target} referenced by ${formatPath(filePath)}`,
                );
                continue;
            }

            if (!existsSync(linkedPath)) {
                errors.push(`Manual page link is missing: ${target} referenced by ${formatPath(filePath)}`);
            }
        }
    }
}

function checkManualApiLink(href, target, filePath) {
    const { pathname } = splitPathnameAndTrailing(href);
    const symbol = decodeURIComponent(pathname.slice(apiReferencePrefix.length)).trim();

    if (!symbol) {
        errors.push(`Manual API link is missing a symbol: ${target} referenced by ${formatPath(filePath)}`);
        return;
    }

    const entries = apiEntriesBySymbol.get(symbol) ?? [];

    if (entries.length === 0) {
        errors.push(`Manual API link target not found: ${target} referenced by ${formatPath(filePath)}`);
        return;
    }

    if (entries.length > 1) {
        errors.push(
            `Manual API link target is ambiguous: ${target} referenced by ${formatPath(filePath)}. Use Namespace.Symbol.`,
        );
    }
}

function getManualLinkTargets(content) {
    const targets = [];

    for (const match of content.matchAll(markdownLinkPattern)) {
        targets.push(match[2]);
    }

    for (const match of content.matchAll(htmlHrefPattern)) {
        targets.push(match[2]);
    }

    return targets;
}

function parseMarkdown(filePath, content) {
    if (!content.startsWith('---')) {
        return {
            frontmatter: {},
            body: content,
        };
    }

    const endMatch = content.slice(3).match(/\r?\n---\r?\n/);
    if (!endMatch || endMatch.index === undefined) {
        errors.push(`Manual page has unterminated frontmatter: ${formatPath(filePath)}`);
        return {
            frontmatter: {},
            body: content,
        };
    }

    const frontmatterEnd = 3 + endMatch.index;
    const delimiterLength = endMatch[0].length;
    const frontmatterText = content.slice(3, frontmatterEnd);
    const body = content.slice(frontmatterEnd + delimiterLength);
    const frontmatter = {};

    for (const line of frontmatterText.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

        if (!match) {
            continue;
        }

        frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }

    return {
        frontmatter,
        body,
    };
}

function getHeadingSignature(content) {
    return content
        .split(/\r?\n/)
        .map(line => line.match(/^(#{2,6})\s+\S/))
        .filter(Boolean)
        .map(match => match[1].length)
        .join(',');
}

function readJson(filePath) {
    try {
        return readJsonFile(filePath, 'example metadata');
    } catch (error) {
        errors.push(`Unable to parse JSON at ${formatPath(filePath)}: ${error.message}`);
        return undefined;
    }
}

function readApiManifest() {
    const source = readFileSync(apiManifestPath, 'utf8');
    const match = source.match(/^export const apiManifest = ([\s\S]*?) as const;\s*export type /);

    if (!match) {
        throw new Error(`Unable to parse API manifest at ${formatPath(apiManifestPath)}.`);
    }

    return JSON.parse(match[1]);
}

function createApiEntriesBySymbol(manifest) {
    const entriesBySymbol = new Map();

    for (const entry of manifest.entries ?? []) {
        addApiEntrySymbol(entriesBySymbol, entry.title, entry);
        addApiEntrySymbol(entriesBySymbol, `${entry.namespace}.${entry.title}`, entry);
    }

    return entriesBySymbol;
}

function addApiEntrySymbol(entriesBySymbol, symbol, entry) {
    const entries = entriesBySymbol.get(symbol);

    if (entries) {
        entries.push(entry);
        return;
    }

    entriesBySymbol.set(symbol, [entry]);
}

function isImageFile(filePath) {
    return ['.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp'].includes(extname(filePath).toLowerCase());
}

function parseMarkdownTarget(target) {
    const trimmed = target.trim();
    const match = trimmed.match(/^(\S+)(.*)$/s);

    return match ? { href: match[1], suffix: match[2] } : undefined;
}

function isExternalReference(href) {
    return /^[a-z][a-z\d+.-]*:/i.test(href);
}

function isApiReference(href) {
    const { pathname } = splitPathnameAndTrailing(href);

    return pathname.startsWith(apiReferencePrefix);
}

function isLocalReference(href) {
    return !href.startsWith('/') && !href.startsWith('#') && !isExternalReference(href);
}

function splitPathnameAndTrailing(href) {
    const match = href.match(/^([^?#]*)([?#].*)?$/s);

    return {
        pathname: match?.[1] ?? href,
        trailing: match?.[2] ?? '',
    };
}

function formatManualAssetPath(filePath) {
    return formatPath(filePath).replace(/^website\/src\/content\/manual\//, 'manual/');
}
