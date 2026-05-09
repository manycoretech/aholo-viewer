import { existsSync, promises as fs } from 'fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { createMarkdownProcessor, parseFrontmatter } from '@astrojs/markdown-remark';
import type { MarkdownHeading } from '@astrojs/markdown-remark';
import type { Locale } from '../i18n/locales';
import { apiManifest } from '../../.generated/api/manifest';
import { getManualAssetBase, getManualAssetOutputPath } from './manual-assets.js';

interface ManualHeading {
    depth: number;
    slug: string;
    text: string;
}

interface ManualFrontmatter {
    title: string;
    description: string;
    order: number;
}

interface ManualEntry extends ManualFrontmatter {
    locale: Locale;
    slug: string;
    headings: ManualHeading[];
    html: string;
}

interface ManualIndexEntry extends ManualFrontmatter {
    locale: Locale;
    slug: string;
}

type ApiManifestEntry = (typeof apiManifest.entries)[number];

const manualRoot = resolve(process.cwd(), 'src/content/manual');
const manualAssetRoot = resolve(manualRoot, 'assets');
const manualAssetBase = getManualAssetBase(import.meta.env.PROD);
const shouldHashManualAssets = import.meta.env.PROD;
const markdownProcessor = createMarkdownProcessor();
const apiEntriesBySymbol = createApiEntriesBySymbol();

export async function getManualEntries(locale: Locale): Promise<ManualIndexEntry[]> {
    const localeDir = resolve(manualRoot, locale);

    if (!isWithinManualRoot(localeDir) || !existsSync(localeDir)) {
        return [];
    }

    const entries = await fs.readdir(localeDir, { withFileTypes: true });
    const pages = await Promise.all(
        entries
            .filter(entry => entry.isFile() && extname(entry.name) === '.md')
            .map(entry => readManualMetadata(locale, entry.name.replace(/\.md$/, ''))),
    );

    return pages.sort((a, b) => a.order - b.order);
}

export async function getManualEntry(locale: Locale, slug: string): Promise<ManualEntry | undefined> {
    const filePath = resolveManualFile(locale, slug);

    if (!filePath || !existsSync(filePath)) {
        return undefined;
    }

    const source = await fs.readFile(filePath, 'utf8');
    const { content, frontmatter } = parseFrontmatter(source);
    const rendered = await (
        await markdownProcessor
    ).render(rewriteManualReferences(content, filePath, locale), {
        fileURL: new URL(pathToFileURL(filePath).href),
        frontmatter,
    });

    return {
        ...toManualMetadata(locale, slug, frontmatter),
        headings: toManualHeadings(rendered.metadata.headings),
        html: rendered.code,
    };
}

export async function getManualNeighbors(locale: Locale, slug: string) {
    const entries = await getManualEntries(locale);
    const index = entries.findIndex(entry => entry.slug === slug);

    return {
        previous: index > 0 ? entries[index - 1] : undefined,
        next: index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined,
    };
}

async function readManualMetadata(locale: Locale, slug: string): Promise<ManualIndexEntry> {
    const filePath = resolveManualFile(locale, slug);

    if (!filePath || !existsSync(filePath)) {
        throw new Error(`Manual page not found: ${locale}/${slug}`);
    }

    const { frontmatter } = parseFrontmatter(await fs.readFile(filePath, 'utf8'));

    return toManualMetadata(locale, slug, frontmatter);
}

function resolveManualFile(locale: Locale, slug: string) {
    const filePath = resolve(manualRoot, locale, `${slug}.md`);

    return isWithinManualRoot(filePath) ? filePath : undefined;
}

function toManualMetadata(locale: Locale, slug: string, frontmatter: Record<string, unknown>): ManualIndexEntry {
    return {
        locale,
        slug,
        title: getFrontmatterString(frontmatter, 'title', locale, slug),
        description: getFrontmatterString(frontmatter, 'description', locale, slug),
        order: getFrontmatterNumber(frontmatter, 'order', locale, slug),
    };
}

function getFrontmatterString(
    frontmatter: Record<string, unknown>,
    key: keyof ManualFrontmatter,
    locale: Locale,
    slug: string,
) {
    const value = frontmatter[key];

    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Manual page ${locale}/${slug} is missing frontmatter string: ${key}`);
    }

    return value;
}

function getFrontmatterNumber(
    frontmatter: Record<string, unknown>,
    key: keyof ManualFrontmatter,
    locale: Locale,
    slug: string,
) {
    const value = Number(frontmatter[key]);

    if (!Number.isFinite(value)) {
        throw new Error(`Manual page ${locale}/${slug} is missing frontmatter number: ${key}`);
    }

    return value;
}

function toManualHeadings(headings: MarkdownHeading[]): ManualHeading[] {
    return headings.map(heading => ({
        depth: heading.depth,
        slug: heading.slug,
        text: heading.text,
    }));
}

function rewriteManualReferences(content: string, filePath: string, locale: Locale) {
    return rewriteManualLinkReferences(rewriteManualAssetReferences(content, filePath), filePath, locale);
}

function rewriteManualAssetReferences(content: string, filePath: string) {
    return content.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (match, opening, target, closing) => {
        const rewrittenTarget = toManualAssetReference(filePath, target);

        return rewrittenTarget ? `${opening}${rewrittenTarget}${closing}` : match;
    });
}

function rewriteManualLinkReferences(content: string, filePath: string, locale: Locale) {
    const markdownLinks = content.replace(
        /(^|[^!])(\[[^\]]*]\()([^)]+)(\))/g,
        (match, prefix, opening, target, closing) => {
            const rewrittenTarget = toManualLinkReference(filePath, locale, target);

            return rewrittenTarget ? `${prefix}${opening}${rewrittenTarget}${closing}` : match;
        },
    );

    return markdownLinks.replace(/\bhref=(["'])([^"']+)\1/g, (match, quote, target) => {
        const rewrittenTarget = toManualLinkReference(filePath, locale, target);

        return rewrittenTarget ? `href=${quote}${rewrittenTarget}${quote}` : match;
    });
}

function toManualAssetReference(filePath: string, target: string) {
    const parsedTarget = parseMarkdownTarget(target);

    if (!parsedTarget || !isLocalReference(parsedTarget.href)) {
        return undefined;
    }

    const { pathname, trailing } = splitPathnameAndTrailing(parsedTarget.href);
    const assetPath = resolve(dirname(filePath), decodeURIComponent(pathname));

    if (!isWithinManualAssetRoot(assetPath)) {
        return undefined;
    }

    const relativeAssetPath = toPosixPath(relative(manualAssetRoot, assetPath));
    const outputAssetPath = getManualAssetOutputPath(relativeAssetPath, assetPath, { hash: shouldHashManualAssets });

    return `${manualAssetBase}/${encodeAssetPath(outputAssetPath)}${trailing}${parsedTarget.suffix}`;
}

function toManualLinkReference(filePath: string, locale: Locale, target: string) {
    return toManualApiReference(locale, target) ?? toManualPageReference(filePath, locale, target);
}

function toManualApiReference(locale: Locale, target: string) {
    const parsedTarget = parseMarkdownTarget(target);

    if (!parsedTarget) {
        return undefined;
    }

    const { pathname, trailing } = splitPathnameAndTrailing(parsedTarget.href);

    if (!pathname.startsWith('api:')) {
        return undefined;
    }

    const symbol = decodeURIComponent(pathname.slice('api:'.length)).trim();

    if (!symbol) {
        throw new Error(`Manual API link is missing a symbol: ${target}`);
    }

    const entry = resolveApiEntry(symbol);

    if (!entry) {
        throw new Error(`Manual API link target not found: ${symbol}`);
    }

    return `/${locale}/api/${encodeRoutePath(entry.slug)}/${trailing}${parsedTarget.suffix}`;
}

function toManualPageReference(filePath: string, locale: Locale, target: string) {
    const parsedTarget = parseMarkdownTarget(target);

    if (!parsedTarget || !isLocalReference(parsedTarget.href)) {
        return undefined;
    }

    const { pathname, trailing } = splitPathnameAndTrailing(parsedTarget.href);

    if (extname(pathname).toLowerCase() !== '.md') {
        return undefined;
    }

    const localeRoot = resolve(manualRoot, locale);
    const pagePath = resolve(dirname(filePath), decodeURIComponent(pathname));

    if (!isWithinRoot(localeRoot, pagePath)) {
        return undefined;
    }

    const slug = toPosixPath(relative(localeRoot, pagePath)).replace(/\.md$/i, '');

    if (!slug) {
        return undefined;
    }

    return `/${locale}/manual/${encodeRoutePath(slug)}/${trailing}${parsedTarget.suffix}`;
}

function parseMarkdownTarget(target: string) {
    const trimmed = target.trim();
    const match = trimmed.match(/^(\S+)(.*)$/s);

    if (!match) {
        return undefined;
    }

    return {
        href: match[1],
        suffix: match[2],
    };
}

function isLocalReference(href: string) {
    return !href.startsWith('/') && !href.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(href);
}

function splitPathnameAndTrailing(href: string) {
    const match = href.match(/^([^?#]*)([?#].*)?$/s);

    return {
        pathname: match?.[1] ?? href,
        trailing: match?.[2] ?? '',
    };
}

function encodeAssetPath(assetPath: string) {
    return assetPath.split('/').map(encodeURIComponent).join('/');
}

function encodeRoutePath(routePath: string) {
    return routePath.split('/').map(encodeURIComponent).join('/');
}

function resolveApiEntry(symbol: string) {
    const entries = apiEntriesBySymbol.get(symbol) ?? [];

    if (entries.length > 1) {
        throw new Error(`Manual API link target is ambiguous: ${symbol}`);
    }

    return entries[0];
}

function createApiEntriesBySymbol() {
    const entriesBySymbol = new Map<string, ApiManifestEntry[]>();

    for (const entry of apiManifest.entries) {
        addApiEntrySymbol(entriesBySymbol, entry.title, entry);
        addApiEntrySymbol(entriesBySymbol, `${entry.namespace}.${entry.title}`, entry);
    }

    return entriesBySymbol;
}

function addApiEntrySymbol(entriesBySymbol: Map<string, ApiManifestEntry[]>, symbol: string, entry: ApiManifestEntry) {
    const entries = entriesBySymbol.get(symbol);

    if (entries) {
        entries.push(entry);
        return;
    }

    entriesBySymbol.set(symbol, [entry]);
}

function isWithinManualRoot(filePath: string) {
    return isWithinRoot(manualRoot, filePath);
}

function isWithinManualAssetRoot(filePath: string) {
    return isWithinRoot(manualAssetRoot, filePath);
}

function isWithinRoot(root: string, filePath: string) {
    const relativePath = relative(root, filePath);

    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function toPosixPath(value: string) {
    return value.replace(/\\/g, '/');
}
