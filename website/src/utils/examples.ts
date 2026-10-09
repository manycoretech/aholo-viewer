import { getCollection } from 'astro:content';
import type { ExampleData, ExampleSurface } from '../content.config.js';
import type { Locale } from '../i18n/locales.js';

export type ExampleItem = Omit<ExampleData, 'surfaces'> & {
    surfaces: ExampleSurface[];
    slug: string;
    code: string;
};

type ExampleEntry = {
    id: string;
    data: ExampleData;
};

const exampleSources = import.meta.glob<string>('../content/examples/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
});

const allExamples: ExampleItem[] = (await getCollection('examples'))
    .filter((e: ExampleEntry) => e.data.surfaces !== 'none')
    .map(
        (entry: ExampleEntry) =>
            ({
                slug: entry.id,
                ...entry.data,
                code: getExampleCode(entry.id),
            }) as ExampleItem,
    )
    .sort((a: ExampleItem, b: ExampleItem) => a.order - b.order);

export const examples: ExampleItem[] = allExamples.filter(example => example.surfaces.includes('examples'));

export const defaultExample = getDefaultExample();

export function getPlaygroundPresets(locale: Locale) {
    return allExamples
        .filter(example => example.surfaces.includes('playground'))
        .map(example => ({
            slug: example.slug,
            title: example.title[locale],
            tags: example.tags,
            code: example.code,
            accent: example.accent,
            renderer: example.renderer,
            showInteractionGuide: example.showInteractionGuide,
        }));
}

function getExampleCode(slug: string) {
    const sourcePath = `../content/examples/${slug}.ts`;
    const code = exampleSources[sourcePath];

    if (!code) {
        throw new Error(`Missing example source for "${slug}".`);
    }

    return code;
}

function getDefaultExample() {
    const example = examples[0];

    if (!example) {
        throw new Error('At least one example is required.');
    }

    return example;
}
