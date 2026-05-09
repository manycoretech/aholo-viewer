import type { Locale } from '../i18n/locales';
import { getApiEntryGroups } from './api';
import { getManualEntries } from './manual';

export const navItems = [
    { key: 'home', href: '/' },
    { key: 'examples', href: '/examples/' },
    { key: 'playground', href: '/playground/' },
    { key: 'viewer', href: '/viewer/' },
    { key: 'manual', href: '/manual/' },
    { key: 'api', href: '/api/' },
] as const;

export interface SidebarItem {
    href?: string;
    label: string;
    description?: string;
    items?: SidebarItem[];
}

export async function manualSidebarItems(locale: Locale): Promise<SidebarItem[]> {
    return (await getManualEntries(locale)).map(page => ({
        href: `/${locale}/manual/${page.slug}/`,
        label: page.title,
        description: page.description,
    }));
}

export function apiSidebarItems(locale: Locale): SidebarItem[] {
    return getApiEntryGroups(locale).map(group => ({
        label: group.label,
        items: group.entries.map(entry => ({
            href: `/${locale}/api/${entry.slug}/`,
            label: entry.title,
            description:
                entry.namespaceLabel === group.label ? entry.kindLabel : `${entry.namespaceLabel} / ${entry.kindLabel}`,
        })),
    }));
}
