export default {
    '**/*.{mjs,js,ts,tsx}': [
        'oxfmt --write --no-error-on-unmatched-pattern',
        'oxlint --fix --no-error-on-unmatched-pattern',
    ],
    '**/*.{md,MD,json,txt,yml,yaml}': ['oxfmt --write --no-error-on-unmatched-pattern'],
};
