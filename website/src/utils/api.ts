import type { Locale } from '../i18n/locales';
import { type ApiCategory, type ApiManifestEntry, apiManifest } from '../../.generated/api/manifest';

export type ApiEntry = ApiManifestEntry & {
    html: string;
    locale: Locale;
};

interface ApiEntryGroup {
    category: ApiCategory;
    label: string;
    entries: ApiEntry[];
}

const knownApiCategories = new Set(apiManifest.categories.map(category => category.category));
const knownApiNamespaces = new Set(apiManifest.namespaces.map(namespace => namespace.namespace));

const htmlModules = import.meta.glob<string>('../../.generated/api/*/**/*.html', {
    eager: true,
    import: 'default',
    query: '?raw',
});

const htmlByLocaleAndSlug = new Map(
    Object.entries(htmlModules).map(([path, html]) => {
        const match = path.match(/\/api\/([^/]+)\/(.+)\.html$/);

        if (!match) {
            throw new Error(`Invalid API doc path: ${path}`);
        }

        return [`${match[1]}/${match[2]}`, html];
    }),
);

const apiEntries = apiManifest.entries
    .flatMap(entry =>
        Object.values(localizedEntries(entry)).map(localizedEntry => {
            if (!knownApiCategories.has(entry.category)) {
                throw new Error(`Unknown API category "${entry.category}". Regenerate the API manifest.`);
            }

            if (!knownApiNamespaces.has(entry.namespace)) {
                throw new Error(`Unknown API namespace "${entry.namespace}". Regenerate the API manifest.`);
            }

            return localizedEntry;
        }),
    )
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export function getApiEntries(locale: Locale) {
    return apiEntries.filter(entry => entry.locale === locale);
}

export function getApiEntryGroups(locale: Locale): ApiEntryGroup[] {
    const entriesByCategory = new Map<ApiCategory, ApiEntry[]>();

    for (const entry of getApiEntries(locale)) {
        const entries = entriesByCategory.get(entry.category);

        if (entries) {
            entries.push(entry);
            continue;
        }

        entriesByCategory.set(entry.category, [entry]);
    }

    return apiManifest.categories.flatMap(category => {
        const entries = entriesByCategory.get(category.category);

        if (!entries?.length) {
            return [];
        }

        return {
            category: category.category,
            label: category.label,
            entries,
        };
    });
}

export function getApiNeighbors(locale: Locale, slug: string) {
    const entries = getApiEntries(locale);
    const index = entries.findIndex(entry => entry.slug === slug);

    return {
        previous: index > 0 ? entries[index - 1] : undefined,
        next: index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined,
    };
}

function localizedEntries(entry: ApiManifestEntry) {
    const entries: Partial<Record<Locale, ApiEntry>> = {};

    for (const [key, html] of htmlByLocaleAndSlug) {
        const separatorIndex = key.indexOf('/');
        const locale = key.slice(0, separatorIndex) as Locale;
        const slug = key.slice(separatorIndex + 1);

        if (slug !== entry.slug) {
            continue;
        }

        entries[locale] = {
            ...entry,
            html,
            locale,
        };
    }

    return entries;
}
