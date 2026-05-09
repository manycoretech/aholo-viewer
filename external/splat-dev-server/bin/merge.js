#!/usr/bin/env node

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { merge } from '../src/merge.js';
import packageJson from '../package.json' with { type: 'json' }

const argv = yargs(hideBin(process.argv))
    .version(packageJson.version)
    .usage('merge-lod -i <meta-files...> -o <output_dir>')
    .option('input', {
        alias: 'i',
        array: true,
        type: 'string',
        demandOption: true,
        description: 'Input lod meta files(lod-meta.json)'
    })
    .option('output', {
        alias: 'o',
        type: 'string',
        demandOption: true,
        description: 'Output directory'
    })
    .argv;

merge(argv.input, argv.output);
