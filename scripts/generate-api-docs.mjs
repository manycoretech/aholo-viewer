import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
    Application,
    BaseRouter,
    DefaultTheme,
    JSX,
    PageEvent,
    PageKind,
    ReflectionKind,
    RendererEvent,
} from 'typedoc';
import { readWebsiteLocales, toPosixPath, workspaceRoot } from './package-utils.mjs';

const root = workspaceRoot;
const rendererDeclaration = resolve(root, 'packages/renderer/dist/index.d.ts');
const tempOutputDir = resolve(root, 'node_modules/.cache/aholo-api-docs');
const contentRoot = resolve(root, 'website/.generated/api');
const locales = readWebsiteLocales();

const apiKindByReflectionKind = new Map([
    [ReflectionKind.Class, 'class'],
    [ReflectionKind.Enum, 'enumeration'],
    [ReflectionKind.Function, 'function'],
    [ReflectionKind.Interface, 'interface'],
    [ReflectionKind.TypeAlias, 'type'],
    [ReflectionKind.Variable, 'variable'],
]);

const folderByKind = {
    class: 'classes',
    enumeration: 'enumerations',
    function: 'functions',
    interface: 'interfaces',
    type: 'type-aliases',
    variable: 'variables',
};

const kindLabels = {
    class: 'Class',
    enumeration: 'Enumeration',
    function: 'Function',
    interface: 'Interface',
    type: 'Type Alias',
    variable: 'Variable',
};

const namespaceOrder = ['core', 'events', 'animation', 'splat-loader', 'draco-loader', 'gltf-loader', 'splat-utils'];

const materialAliasDocs = new Map([
    ['MeshBasicMaterial', { base: 'BaseMeshBasicMaterial', parameters: 'MeshBasicMaterialParameters' }],
    ['MeshPhongMaterial', { base: 'BaseMeshPhongMaterial', parameters: 'MeshPhongMaterialParameters' }],
    ['SpriteMaterial', { base: 'BaseSpriteMaterial', parameters: 'SpriteMaterialParameters' }],
]);

await rm(tempOutputDir, { recursive: true, force: true });
await mkdir(tempOutputDir, { recursive: true });
await mkdir(contentRoot, { recursive: true });

const apiNamespaces = await createApiNamespacesFromRendererDeclaration();
const namespaceBySlug = new Map(apiNamespaces.map(namespace => [namespace.slug, namespace]));
const categoryLabels = Object.fromEntries(
    apiNamespaces.map(({ category, categoryLabel }) => [category, categoryLabel]),
);
const renderedPages = new Map();
const typedocPageOrder = new Map();

class AholoApiRouter extends BaseRouter {
    getPageKind(target) {
        if (target?.kindOf?.(ReflectionKind.SomeModule)) {
            return PageKind.Reflection;
        }

        return getApiKind(target) ? PageKind.Reflection : undefined;
    }

    getIdealBaseName(reflection) {
        const apiKind = getApiKind(reflection);
        const namespace = getReflectionNamespace(reflection);

        if (!apiKind || !namespace) {
            return toKebabCase(reflection.name);
        }

        const folder = isMaterialAliasDocReflection(reflection) ? folderByKind.variable : folderByKind[apiKind];

        return [namespace.slug, folder, toKebabCase(reflection.name)].join('/');
    }
}

class AholoApiFragmentTheme extends DefaultTheme {
    render(page) {
        if (!page.isReflectionEvent()) {
            return '';
        }

        const template = {
            [PageKind.Reflection]: this.reflectionTemplate,
            [PageKind.Document]: this.documentTemplate,
            [PageKind.Index]: this.indexTemplate,
            [PageKind.Hierarchy]: this.hierarchyTemplate,
        }[page.pageKind];

        return template ? JSX.renderElement(template(page)) : '';
    }
}

const app = await Application.bootstrapWithPlugins({
    entryPoints: [toPosixPath(rendererDeclaration)],
    out: toPosixPath(tempOutputDir),
    readme: 'none',
    router: 'aholo-api',
    theme: 'aholo-api-fragment',
    disableSources: true,
    excludeInternal: true,
    excludePrivate: true,
    excludeProtected: true,
    skipErrorChecking: true,
    sort: ['source-order'],
    validation: false,
    hideGenerator: true,
    includeHierarchySummary: false,
});

app.renderer.defineRouter('aholo-api', AholoApiRouter);
app.renderer.defineTheme('aholo-api-fragment', AholoApiFragmentTheme);
app.renderer.on(RendererEvent.BEGIN, event => {
    event.pages.forEach((page, index) => {
        typedocPageOrder.set(toPosixPath(page.url), index + 1);
    });
});
app.renderer.on(PageEvent.END, event => {
    const sourcePath = toPosixPath(relative(tempOutputDir, event.filename));
    const metadata = createMetadata(event, sourcePath);

    if (!metadata) {
        return;
    }

    renderedPages.set(sourcePath, metadata);
});

const project = await app.convert();

if (!project) {
    throw new Error('TypeDoc failed to convert the renderer entry.');
}

await app.generateOutputs(project);

const entries = [...renderedPages.values()].sort(compareEntries).map((entry, index) => ({
    ...entry,
    order: index + 1,
}));
const targetPaths = new Map(entries.map(entry => [entry.sourcePath, `${entry.slug}.html`]));
const expectedOutputPaths = new Set();

await writeApiManifest(entries);

for (const entry of entries) {
    for (const locale of locales) {
        const outputPath = resolve(contentRoot, locale, `${entry.slug}.html`);
        const content = `${rewriteHtmlLinks(entry.html, entry.sourcePath, targetPaths, locale).trim()}\n`;

        expectedOutputPaths.add(resolve(outputPath));
        await writeFileIfChanged(outputPath, content);
    }
}

await removeStaleGeneratedFiles(expectedOutputPaths);
await pruneEmptyDirectories(contentRoot);
await rm(tempOutputDir, { recursive: true, force: true });

console.log(`[api-docs] Generated ${entries.length} API HTML pages for ${locales.join(', ')}.`);

async function createApiNamespacesFromRendererDeclaration() {
    let declarationSource;

    try {
        declarationSource = await readFile(rendererDeclaration, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(
                `Renderer declaration not found at ${toPosixPath(relative(root, rendererDeclaration))}. Run pnpm build:renderer first.`,
            );
        }

        throw error;
    }

    const sourceFile = ts.createSourceFile(rendererDeclaration, declarationSource, ts.ScriptTarget.Latest, true);
    const declaredNamespaces = collectDeclaredNamespaces(sourceFile);
    const namespaces = [
        {
            slug: 'core',
            name: 'Core',
            category: 'core',
            categoryLabel: 'Core',
            namespaceLabel: 'Core',
        },
    ];
    const knownSlugs = new Set(namespaces.map(namespace => namespace.slug));

    for (const namespaceLabel of getExportedNamespaceLabels(sourceFile, declaredNamespaces)) {
        const namespace = createNamespaceEntry(namespaceLabel);

        if (knownSlugs.has(namespace.slug)) {
            continue;
        }

        namespaces.push(namespace);
        knownSlugs.add(namespace.slug);
    }

    return orderApiNamespaces(namespaces);
}

function collectDeclaredNamespaces(sourceFile) {
    const namespaces = new Set();

    for (const statement of sourceFile.statements) {
        if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
            namespaces.add(statement.name.text);
        }
    }

    return namespaces;
}

function getExportedNamespaceLabels(sourceFile, declaredNamespaces) {
    const labels = [];

    for (const statement of sourceFile.statements) {
        if (ts.isModuleDeclaration(statement) && hasExportModifier(statement) && ts.isIdentifier(statement.name)) {
            labels.push(statement.name.text);
            continue;
        }

        if (
            !ts.isExportDeclaration(statement) ||
            !statement.exportClause ||
            !ts.isNamedExports(statement.exportClause)
        ) {
            continue;
        }

        for (const element of statement.exportClause.elements) {
            const localName = element.propertyName?.text ?? element.name.text;

            if (declaredNamespaces.has(localName)) {
                labels.push(element.name.text);
            }
        }
    }

    return labels;
}

function orderApiNamespaces(namespaces) {
    const orderBySlug = new Map(namespaceOrder.map((slug, index) => [slug, index]));

    return namespaces
        .map((namespace, sourceIndex) => ({ namespace, sourceIndex }))
        .sort((left, right) => {
            const leftOrder = orderBySlug.get(left.namespace.slug) ?? Number.POSITIVE_INFINITY;
            const rightOrder = orderBySlug.get(right.namespace.slug) ?? Number.POSITIVE_INFINITY;

            return leftOrder - rightOrder || left.sourceIndex - right.sourceIndex;
        })
        .map(({ namespace }) => namespace);
}

function createNamespaceEntry(namespaceLabel) {
    return {
        slug: toKebabCase(namespaceLabel),
        name: namespaceLabel,
        category: toKebabCase(namespaceLabel),
        categoryLabel: namespaceLabel,
        namespaceLabel,
    };
}

function hasExportModifier(node) {
    return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

async function writeFileIfChanged(filePath, content) {
    try {
        if ((await readFile(filePath, 'utf8')) === content) {
            return;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}

async function listGeneratedContentFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const filePath = join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await listGeneratedContentFiles(filePath)));
            continue;
        }

        if (entry.isFile() && ['.html', '.md'].includes(extname(entry.name))) {
            files.push(filePath);
        }
    }

    return files;
}

async function removeStaleGeneratedFiles(expectedOutputPaths) {
    for (const filePath of await listGeneratedContentFiles(contentRoot)) {
        if (!expectedOutputPaths.has(resolve(filePath))) {
            await rm(filePath, { force: true });
        }
    }
}

async function pruneEmptyDirectories(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            await pruneEmptyDirectories(join(directory, entry.name));
        }
    }

    if (resolve(directory) === resolve(contentRoot)) {
        return;
    }

    if ((await readdir(directory)).length === 0) {
        await rm(directory, { recursive: true, force: true });
    }
}

async function writeApiManifest(entries) {
    const categories = [];
    const categoriesBySlug = new Map();
    const namespaces = [];
    const namespaceKeys = new Set();

    for (const namespace of apiNamespaces) {
        if (!categoriesBySlug.has(namespace.category)) {
            const category = {
                category: namespace.category,
                label: namespace.categoryLabel,
                namespaces: [],
            };

            categoriesBySlug.set(namespace.category, category);
            categories.push(category);
        }

        const namespaceKey = `${namespace.category}:${namespace.name}`;

        if (namespaceKeys.has(namespaceKey)) {
            continue;
        }

        namespaceKeys.add(namespaceKey);

        const namespaceEntry = {
            namespace: namespace.name,
            label: namespace.namespaceLabel,
            category: namespace.category,
            slug: namespace.slug,
        };

        namespaces.push(namespaceEntry);
        categoriesBySlug.get(namespace.category)?.namespaces.push(namespaceEntry);
    }

    const kinds = [...new Set(entries.map(entry => entry.kind))].sort();
    const manifest = {
        categories,
        namespaces,
        kinds,
        entries: entries.map(({ html, sourcePath, sourceOrder, ...entry }) => entry),
    };
    const content = [
        'export const apiManifest = ',
        JSON.stringify(manifest, null, 2),
        ' as const;\n\n',
        'export type ApiCategory = (typeof apiManifest.categories)[number]["category"];\n',
        'export type ApiNamespace = (typeof apiManifest.namespaces)[number]["namespace"];\n',
        'export type ApiKind = (typeof apiManifest.kinds)[number];\n',
        'export type ApiManifestEntry = (typeof apiManifest.entries)[number];\n',
        'export type ApiHeading = ApiManifestEntry["headings"][number];\n',
    ].join('');

    await writeFileIfChanged(resolve(contentRoot, 'manifest.ts'), content);
}

function createMetadata(event, sourcePath) {
    const reflection = event.model;
    const kind = getApiKind(reflection);
    const namespace = getReflectionNamespace(reflection);
    const html = cleanTypeDocHtml(event.contents ?? '');

    if (!kind || !namespace || !sourcePath.endsWith('.html')) {
        return undefined;
    }

    const category = namespace.category;
    const title = reflection.name;
    const slug = sourcePath.replace(/\.html$/, '');

    return {
        sourcePath,
        slug,
        title,
        description:
            getReflectionDescription(reflection) || `${namespace.name}.${title} exported from @manycore/aholo-viewer.`,
        sourceOrder: typedocPageOrder.get(sourcePath) ?? Number.POSITIVE_INFINITY,
        kind,
        kindLabel: kindLabels[kind],
        namespace: namespace.name,
        namespaceLabel: namespace.namespaceLabel,
        category,
        categoryLabel: categoryLabels[category],
        signature: getReflectionSignature(reflection, kind),
        headings: getApiHtmlHeadings(html, event),
        html,
    };
}

function getApiKind(reflection) {
    for (const [reflectionKind, apiKind] of apiKindByReflectionKind) {
        if (reflection?.kindOf?.(reflectionKind)) {
            return apiKind;
        }
    }

    return undefined;
}

function isMaterialAliasDocReflection(reflection) {
    return reflection?.kindOf?.(ReflectionKind.Class) && materialAliasDocs.has(reflection.name);
}

function getReflectionNamespace(reflection) {
    let topLevel = reflection;

    while (topLevel?.parent && !topLevel.parent.isProject?.()) {
        topLevel = topLevel.parent;
    }

    const slug = toKebabCase(topLevel?.name ?? '');

    return namespaceBySlug.get(slug) ?? namespaceBySlug.get('core');
}

function getReflectionDescription(reflection) {
    return (
        displayPartsToText(reflection.comment?.summary) ||
        displayPartsToText(getPrimarySignature(reflection)?.comment?.summary) ||
        undefined
    );
}

function getReflectionSignature(reflection, kind) {
    const signature = kind === 'class' ? getConstructorSignature(reflection) : getPrimarySignature(reflection);

    if (signature) {
        const params = (signature.parameters ?? []).map(parameter => parameter.toString()).join(', ');
        const returnType = signature.type?.toString();
        const name = kind === 'class' ? `new ${reflection.name}` : reflection.name;

        return `${name}(${params})${returnType ? `: ${returnType}` : ''}`;
    }

    if (kind === 'class') {
        return `class ${reflection.name}`;
    }

    if (kind === 'enumeration') {
        return `enum ${reflection.name}`;
    }

    if (kind === 'interface') {
        return `interface ${reflection.name}`;
    }

    if (kind === 'type') {
        return `type ${reflection.name}${reflection.type ? ` = ${reflection.type.toString()}` : ''}`;
    }

    if (kind === 'variable') {
        return `const ${reflection.name}${reflection.type ? `: ${reflection.type.toString()}` : ''}`;
    }

    return `${kind} ${reflection.name}`;
}

function getConstructorSignature(reflection) {
    const constructor = reflection.children?.find(child => child.kindOf(ReflectionKind.Constructor));

    return constructor?.signatures?.[0];
}

function getPrimarySignature(reflection) {
    return reflection.signatures?.[0] ?? reflection.getSignature ?? reflection.setSignature;
}

function displayPartsToText(parts) {
    const value = parts
        ?.map(part => part.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

    return value || undefined;
}

function toApiHeading(heading) {
    const slug = heading.link?.replace(/^#/, '');

    if (!slug) {
        return undefined;
    }

    return {
        depth: heading.level ?? 2,
        slug,
        text: heading.text,
    };
}

function getApiHtmlHeadings(html, event) {
    const htmlHeadings = extractTypeDocHtmlHeadings(html);

    if (htmlHeadings.length > 0) {
        return htmlHeadings;
    }

    return event.pageHeadings.map(toApiHeading).filter(Boolean);
}

function compareEntries(left, right) {
    if (left.sourceOrder !== right.sourceOrder) {
        return left.sourceOrder - right.sourceOrder;
    }

    return left.title.localeCompare(right.title);
}

function rewriteHtmlLinks(content, sourcePath, targetPaths, locale) {
    const sourceDir = sourcePath.split('/').slice(0, -1).join('/');

    return content.replace(
        /\bhref=(["'])(?![a-z][a-z0-9+.-]*:|#|\/)([^"']+?\.html)(#[^"']*)?\1/gi,
        (match, quote, href, hash = '') => {
            const targetSourcePath = normalizeRelativePath(sourceDir, href);
            const targetPath = targetPaths.get(targetSourcePath);

            if (!targetPath) {
                return match;
            }

            const routePath = targetPath.replace(/\.html$/, '');

            return `href=${quote}/${locale}/api/${routePath}/${hash}${quote}`;
        },
    );
}

function cleanTypeDocHtml(content) {
    const normalized = stripTypeDocOptionalTags(stripTypeDocAssetIcons(content).replace(/\u00a0/g, ' '));

    return addTypeDocGroupHeadingIds(
        removeTypeDocTypeDeclarationSignatures(inlineTypeDocDefaultValues(removeTypeDocIndexGroup(normalized))),
    );
}

function stripTypeDocAssetIcons(content) {
    return content.replace(/<svg\b[^>]*>\s*<use\s+href=(["'])[^"']*assets\/icons\.svg#[^"']+\1><\/use>\s*<\/svg>/g, '');
}

function stripTypeDocOptionalTags(content) {
    return content.replace(/<code class="tsd-tag">Optional<\/code>/g, '');
}

function inlineTypeDocDefaultValues(content) {
    return inlineTypeDocMemberDefaultValues(inlineTypeDocParameterDefaultValues(content));
}

function inlineTypeDocMemberDefaultValues(content) {
    return replaceTypeDocBlocks(
        content,
        /<section\b[^>]*class=(["'])[^"']*\btsd-member\b[^"']*\1[^>]*>/g,
        'section',
        inlineTypeDocDefaultValueInBlock,
    );
}

function inlineTypeDocParameterDefaultValues(content) {
    return replaceTypeDocBlocks(
        content,
        /<li\b[^>]*class=(["'])[^"']*\btsd-parameter\b[^"']*\1[^>]*>/g,
        'li',
        inlineTypeDocDefaultValueInBlock,
    );
}

function replaceTypeDocBlocks(content, pattern, tagName, replacer) {
    let cleaned = '';
    let cursor = 0;
    let match;

    while ((match = pattern.exec(content))) {
        if (match.index < cursor) {
            continue;
        }

        const end = findMatchingElementEnd(content, match.index, tagName);

        if (end === -1) {
            continue;
        }

        cleaned += content.slice(cursor, match.index);
        cleaned += replacer(content.slice(match.index, end));
        cursor = end;
        pattern.lastIndex = end;
    }

    return cleaned + content.slice(cursor);
}

function removeTypeDocTypeDeclarationSignatures(content) {
    return replaceTypeDocBlocks(
        content,
        /<section\b[^>]*class=(["'])[^"']*\btsd-member\b[^"']*\1[^>]*>/g,
        'section',
        block =>
            block.includes('<div class="tsd-type-declaration">')
                ? block
                      .replace(/<div class="tsd-signature\b[^>]*>[\s\S]*?<\/div>/, '')
                      .replace(/(<div class="tsd-type-declaration">)\s*<h4>Type Declaration<\/h4>/, '$1')
                : block,
    );
}

function inlineTypeDocDefaultValueInBlock(block) {
    const defaultBlock = block.match(/<div class="tsd-tag-default(?:Value)?">[\s\S]*?<\/div>/)?.[0];

    if (!defaultBlock) {
        return block;
    }

    const defaultValue = extractTypeDocDefaultValue(defaultBlock);

    if (!defaultValue) {
        return block;
    }

    const blockWithoutDefault = block
        .replace(defaultBlock, '')
        .replace(/<div class="tsd-comment tsd-typography">\s*<\/div>/g, '');

    return appendTypeDocDefaultValueToTitle(blockWithoutDefault, defaultValue);
}

function extractTypeDocDefaultValue(defaultBlock) {
    const content = defaultBlock
        .replace(/^<div class="tsd-tag-default(?:Value)?">/, '')
        .replace(/<\/div>$/, '')
        .replace(/<h4\b[\s\S]*?<\/h4>/, '')
        .trim();
    const paragraphs = [...content.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => match[1].trim()).filter(Boolean);
    const inlineCodeMatch = (paragraphs[0] ?? content).match(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/);

    if (inlineCodeMatch) {
        return inlineCodeMatch[1].trim();
    }

    const value = (paragraphs.length > 0 ? paragraphs.join(' ') : content).trim();
    const codeMatch = value.match(/^<code(?:\s[^>]*)?>([\s\S]*?)<\/code>$/);

    return (codeMatch?.[1] ?? value).trim();
}

function appendTypeDocDefaultValueToTitle(block, defaultValue) {
    const defaultHtml = `<code class="tsd-default-value">${defaultValue}</code>`;
    const titledBlock = block.replace(/<(h3|h5)\b([^>]*)>([\s\S]*?)<\/\1>/, (match, tagName, attributes, inner) => {
        const title = inner.replace(
            /(\s*<a\b[^>]*class=(["'])[^"']*\btsd-anchor-icon\b[^"']*\2[^>]*><\/a>\s*)$/,
            `${defaultHtml}$1`,
        );

        return title === inner
            ? `<${tagName}${attributes}>${inner}${defaultHtml}</${tagName}>`
            : `<${tagName}${attributes}>${title}</${tagName}>`;
    });

    if (titledBlock !== block) {
        return titledBlock;
    }

    return block.replace(/(<span\b[^>]*>[\s\S]*?)(<\/span>)/, `$1${defaultHtml}$2`);
}

function removeTypeDocIndexGroup(content) {
    const marker = '<section class="tsd-panel-group tsd-index-group">';
    let cleaned = '';
    let cursor = 0;

    while (cursor < content.length) {
        const start = content.indexOf(marker, cursor);

        if (start === -1) {
            cleaned += content.slice(cursor);
            break;
        }

        const end = findMatchingSectionEnd(content, start);

        cleaned += content.slice(cursor, start);
        cursor = end === -1 ? start + marker.length : end;
    }

    return cleaned;
}

function findMatchingSectionEnd(content, start) {
    return findMatchingElementEnd(content, start, 'section');
}

function findMatchingElementEnd(content, start, tagName) {
    const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, 'g');
    tagPattern.lastIndex = start;

    let depth = 0;
    let match;

    while ((match = tagPattern.exec(content))) {
        if (match[0].startsWith('</')) {
            depth -= 1;
        } else {
            depth += 1;
        }

        if (depth === 0) {
            return tagPattern.lastIndex;
        }
    }

    return -1;
}

function addTypeDocGroupHeadingIds(content) {
    const usedSlugs = new Map();

    return content.replace(
        /(<summary\b[^>]*\bdata-key=(["'])section-[^"']+\2[^>]*>\s*)<h2>(.*?)<\/h2>/g,
        (match, summaryOpen, quote, headingHtml) => {
            const baseSlug = toKebabCase(stripHtml(headingHtml)) || 'section';
            const count = usedSlugs.get(baseSlug) ?? 0;
            const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;

            usedSlugs.set(baseSlug, count + 1);

            return `${summaryOpen}<h2 id="${slug}">${headingHtml}</h2>`;
        },
    );
}

function extractTypeDocHtmlHeadings(content) {
    return [
        ...content.matchAll(
            /<summary\b[^>]*\bdata-key=(["'])section-[^"']+\1[^>]*>\s*<h2 id=(["'])([^"']+)\2>(.*?)<\/h2>/g,
        ),
    ]
        .map(match => ({
            depth: 2,
            index: match.index ?? 0,
            slug: match[3],
            text: typeDocHeadingText(match[4]),
        }))
        .concat(
            [...content.matchAll(/<h3\b[^>]*\bid=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/h3>/g)].map(match => ({
                depth: 3,
                index: match.index ?? 0,
                slug: match[2],
                text: typeDocHeadingText(match[3]),
            })),
        )
        .filter(heading => heading.text)
        .sort((left, right) => left.index - right.index)
        .map(({ index, ...heading }) => heading);
}

function typeDocHeadingText(content) {
    return decodeBasicHtml(
        stripHtml(
            content
                .replace(/<a\b[^>]*class=(["'])[^"']*\btsd-anchor-icon\b[^"']*\1[^>]*><\/a>/g, '')
                .replace(/<code class="tsd-default-value">[\s\S]*?<\/code>/g, '')
                .replace(/<code class="tsd-tag">[\s\S]*?<\/code>/g, '')
                .replace(/<span class="tsd-flag">[\s\S]*?<\/span>/g, '')
                .replace(/<wbr\s*\/?>/g, ''),
        ),
    );
}

function stripHtml(content) {
    return content.replace(/<[^>]*>/g, '').trim();
}

function decodeBasicHtml(content) {
    return content
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function normalizeRelativePath(sourceDir, href) {
    const stack = sourceDir ? sourceDir.split('/') : [];

    for (const part of href.split('/')) {
        if (part === '.' || part === '') {
            continue;
        }

        if (part === '..') {
            stack.pop();
            continue;
        }

        stack.push(part);
    }

    return stack.join('/');
}

function toKebabCase(value) {
    return value
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Za-z])(\d+)/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
}
