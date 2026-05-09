export const defaultLocale = 'zh-CN' as const;

export const localeStorageKey = 'aholo:locale';

export const locales = [
    {
        code: 'zh-CN',
        label: '简体中文',
        shortLabel: '中',
    },
    {
        code: 'en-US',
        label: 'English',
        shortLabel: 'EN',
    },
] as const;

export type Locale = (typeof locales)[number]['code'];

export function getLocaleMeta(locale: Locale) {
    return locales.find(item => item.code === locale) ?? locales[0];
}
