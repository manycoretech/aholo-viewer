import { defineConfig } from 'oxfmt';

export default defineConfig({
    printWidth: 120,
    singleQuote: true,
    arrowParens: 'avoid',
    sortPackageJson: false,
    endOfLine: 'lf',
    ignorePatterns: [
        '*.log',
        '.env',
        '.env.*',
        '.codex/',
        '.vscode/',
        '**/build/**',
        '**/dist/**',
        // website
        '**/.astro/**',
        '**/.generated/**',
        // externals
        'external/splat-dev-server/**',
        '.clang-format',
        '.clang-tidy',
    ],
});
