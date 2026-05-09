import { getCollection, type CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n/locales';

type ExampleData = CollectionEntry<'examples'>['data'];

export type ExampleItem = ExampleData & {
    slug: string;
    code: string;
};

const exampleSources = import.meta.glob<string>('../content/examples/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
});

const allExamples: ExampleItem[] = (await getCollection('examples'))
    .map(entry => ({
        slug: entry.id,
        ...entry.data,
        code: getExampleCode(entry.id),
    }))
    .sort((a, b) => a.order - b.order);

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
