import { defineConfig } from 'oxlint';

export default defineConfig({
    env: {
        browser: true,
        node: true,
        es2026: true,
    },
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'promise', 'import'],
    ignorePatterns: [
        '.github/*',
        '**/build/**',
        '**/dist/**',
        '**/bin/**',
        '**/scripts/**',
        // website
        '**/.astro/**',
        '**/.generated/**',
        // externals
        'external/splat-dev-server/**',
    ],
    rules: {
        'no-console': 'off',
        'guard-for-in': 'off',
        'no-shadow': 'off',
        'no-use-before-define': 'off',
        'typescript/prefer-for-of': 'off',
        'no-loss-of-precision': 'off',
        'no-unused-expressions': [
            'deny',
            {
                allowShortCircuit: true,
                allowTernary: true,
            },
        ],
        'no-unused-vars': [
            'error',
            {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            },
        ],
        'unicorn/no-new-array': 'off',
        'no-extra-boolean-cast': 'off',
        'typescript/no-this-alias': 'off',
        'typescript/no-duplicate-enum-values': 'off',
        'erasing-op': 'off',
    },
});
