#!/usr/bin/env node
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import packageJson from '../package.json' with { type: 'json' };
import { run, enumerateAdapters, PipelineError } from '../dist/index.js';
import { execute } from '../dist/process.js';

const ExtraText = `
Transform Gaussian splats file
===================================
SUPPORTED INPUTS
    .ply   .compressed.ply   .sog   meta.json   .ksplat   .splat   .spz   .lcc   .lcc2   .esz
    .zip   LCC, LCC2, or SOG archive; LCC2 reads LOD0 and environment splats
    Unpacked LCC/LCC2: pass the .lcc/.lcc2 metadata file; resources are resolved relative to it

SUPPORTED OUTPUTS
    .ply   .spz   .uspz   .splat   .sog   .esz
`;

const splitNormalOption = {
    describe: 'block split reference normal (case-insensitive)',
    choices: [0, 1, 2, 3, 'None', 'X', 'Y', 'Z'],
    coerce(value) {
        if (typeof value !== 'string') return value;
        const normal = value.toUpperCase();
        return normal === 'NONE' ? 'None' : normal;
    },
};

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
        describe: 'Execute a task pipeline from configuration file, - for stdin',
        builder(argv) {
            argv.positional('config', { describe: 'pipeline config file', type: 'string' });
        },
        async handler(argv) {
            const config = argv.config || '-';
            await execute([config], { stdin: config === '-' ? 'inherit' : 'ignore' });
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
                .option('split-normal', splitNormalOption)
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
                        type: 'AutoLod',
                        config: { input: 'cache0', output: 'cache0', ratio: argv.ratio, splitNormal: argv.splitNormal },
                    },
                    { id: '2', type: 'Write', config: { input: 'cache0', output: argv.output } },
                ],
            });
        },
    })
    .command('lod:auto-chunk <input> <output>', false, {
        describe: 'Generate auto-chunk-lod for gaussian splat file',
        builder(argv) {
            argv.option('max-chunk-counts', { describe: 'max chunk counts', type: 'number' })
                .option('type', {
                    alias: 't',
                    choices: ['ply', 'spz', 'splat', 'sog', 'esz'],
                    demandOption: true,
                    describe: 'output file type',
                    type: 'string',
                })
                .option('split-normal', splitNormalOption)
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
                            splitNormal: argv.splitNormal,
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
            argv.option('max-chunk-counts', { describe: 'max-chunk-counts', type: 'number' })
                .option('type', {
                    alias: 't',
                    choices: ['ply', 'spz', 'splat', 'sog', 'esz'],
                    demandOption: true,
                    describe: 'output file type',
                    type: 'string',
                })
                .option('split-normal', splitNormalOption)
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
                        config: {
                            input: 'cache0',
                            output: 'cache0',
                            type: argv.type,
                            maxChunkCounts: argv.maxChunkCounts,
                            splitNormal: argv.splitNormal,
                        },
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

try {
    await cli.parseAsync();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof PipelineError ? error.exitCode : 1;
}
