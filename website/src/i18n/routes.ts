import type { Locale } from './locales';

export function localizedPath(locale: Locale, path = '/') {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `/${locale}${normalized}`.replace(/\/{2,}/g, '/');
}

export function swapLocale(pathname: string, currentLocale: Locale, targetLocale: Locale) {
    const prefix = `/${currentLocale}`;
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : '/';
    return localizedPath(targetLocale, rest);
}
