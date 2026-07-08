#!/usr/bin/env node
import fs from 'node:fs';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import packageJson from '../package.json' with { type: 'json' };
import { run } from '../dist/index.js';
import { enumerateAdapters } from '../dist/utils/index.js';

const ExtraText = `
Transform Gaussian splats file
===================================
SUPPORTED INPUTS
    .ply   .compressed.ply   .sog   meta.json   .ksplat   .splat   .spz   .lcc    .esz

SUPPORTED OUTPUTS
    .ply   .spz   .uspz   .splat   .sog   .esz
`;

function readJsonConfig(config) {
    const content = fs.readFileSync(config, { encoding: 'utf-8' });
    return JSON.parse(content);
}

const cli = yargs(hideBin(process.argv))
    .scriptName('splat-transform')
    .version(packageJson.version)
    .showHelpOnFail(false)
    .parserConfiguration({
        'boolean-negation': false,
        'duplicate-arguments-array': false,
    })
    .alias('h', 'help')
    .alias('v', 'version')
    .usage(`${ExtraText}\n$0 <config>`)
    .strict()
    .command({
        command: '$0 <config>',
        describe: 'Execute a task pipeline from configuration file',
        builder(argv) {
            argv.positional('config', { describe: 'pipeline config file', type: 'string' });
        },
        async handler(argv) {
            await run(readJsonConfig(argv.config));
        },
    })
    .command('create <input> <output>', false, {
        describe: 'Merge & Transform gaussian splat file',
        builder(argv) {
            argv.positional('input', { describe: 'input file', type: 'string' }).positional('output', {
                describe: 'output file',
                type: 'string',
            });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    { id: '1', type: 'Modify', config: { input: 'cache0', output: 'cache0' } },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('lod:loading <input> <output>', false, {
        describe: 'Generate loading-lod for gaussian splat file',
        builder(argv) {
            argv.option('ratio', { describe: 'ratio', type: 'number' })
                .positional('input', { describe: 'input filepath', type: 'string' })
                .positional('output', { describe: 'output filepath', type: 'string' });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    { id: '1', type: 'SkeletonLod', config: { input: 'cache0', output: 'cache0', ratio: argv.ratio } },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('lod:flex <input> <output>', false, {
        describe: 'Generate flex-lod for gaussian splat file',
        builder(argv) {
            argv.option('score', { demandOption: true, type: 'string' })
                .option('ratio', { describe: 'ratio', type: 'number' })
                .positional('input', { describe: 'input filepath', type: 'string' })
                .positional('output', { describe: 'output filepath', type: 'string' });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    {
                        id: '1',
                        type: 'FlexLod',
                        config: { input: 'cache0', output: 'cache0', ratio: argv.ratio, scorePath: argv.score },
                    },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('lod:auto <input> <output>', false, {
        describe: 'Generate auto-lod for gaussian splat file',
        builder(argv) {
            argv.option('ratio', { describe: 'ratio', type: 'number' })
                .positional('input', { describe: 'input filepath', type: 'string' })
                .positional('output', { describe: 'output filepath', type: 'string' });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    { id: '1', type: 'AutoLod', config: { input: 'cache0', output: 'cache0', ratio: argv.ratio } },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('lod:auto-chunk <input> <output>', false, {
        describe: 'Generate auto-chunk-lod for gaussian splat file',
        builder(argv) {
            argv.option('type', {
                alias: 't',
                choices: ['ply', 'spz', 'splat', 'sog', 'esz'],
                demandOption: true,
                describe: 'output file type',
                type: 'string',
            })
                .option('max-chunk-counts', { describe: 'max chunk counts', type: 'number' })
                .positional('input', { describe: 'input filepath', type: 'string' })
                .positional('output', { describe: 'output directory', type: 'string' });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    {
                        id: '1',
                        type: 'AutoChunkLod',
                        config: {
                            input: 'cache0',
                            output: 'cache0',
                            type: argv.type,
                            maxChunkCounts: argv.maxChunkCounts,
                        },
                    },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('split <input> <output>', false, {
        describe: 'Split splat file into blocks',
        builder(argv) {
            argv.option('type', {
                alias: 't',
                choices: ['ply', 'spz', 'splat', 'sog'],
                demandOption: true,
                describe: 'output file type',
                type: 'string',
            })
                .option('precision', { describe: 'precision', type: 'number' })
                .positional('input', { describe: 'input filepath', type: 'string' })
                .positional('output', { describe: 'output directory', type: 'string' });
        },
        async handler(argv) {
            await run({
                version: 1,
                tasks: [
                    { id: '0', type: 'Read', config: { inputs: [argv.input], output: 'cache0' } },
                    {
                        id: '1',
                        type: 'SplitSplatTask',
                        config: { input: 'cache0', output: 'cache0', type: argv.type, blockPrecision: argv.precision },
                    },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('list:gpu', false, {
        describe: 'List all available gpu adapters',
        builder() {},
        async handler() {
            const adapters = await enumerateAdapters();
            const alignment = Math.ceil(Math.log10(adapters.length));
            for (const adapter of adapters) {
                console.log(`Adapter ${adapter.index.toString().padStart(alignment, ' ')}: ${adapter.name}`);
            }
        },
    });

await cli.parseAsync();
