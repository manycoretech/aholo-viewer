#!/usr/bin/env node
import fs from 'node:fs';
import { program } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { runner } from '../dist/index.js';

const ExtraText = `
Transform Gaussian splats file
===================================
SUPPORTED INPUTS
    .ply   .compressed.ply   .sog   meta.json   .ksplat   .splat   .spz   .lcc    .esz

SUPPORTED OUTPUTS
    .ply   .spz   .uspz   .splat   .sog   .esz
`;

program
    .name(packageJson.name)
    .version(packageJson.version)
    .addHelpText('beforeAll', ExtraText);

program
    .description('Execute a task pipeline from configuration file')
    .argument('<path>', 'pipeline config filepath')
    .action((path) => {
        const content = fs.readFileSync(path, { encoding: 'utf-8' });
        runner(JSON.parse(content));
    });

program
    .command('create')
    .description('Merge & Transform gaussian splat file')
    .argument('<input>', 'input filepath')
    .argument('<output>', 'output filepath')
    .action((input, output) => {
        runner({
            version: 1,
            tasks: [
                { id: '0', type: 'Read', config: { inputs: [input], output: 'cache0' } },
                { id: '1', type: 'Modify', config: { input: 'cache0', output: 'cache0' } },
                { id: '2', type: 'Write', config: { input: 'cache0', output: output } },
            ],
        });
    });

program
    .command('lod:loading')
    .description('Generate loading-lod for gaussian splat file')
    .option('--ratio <number>')
    .argument('<input>', 'input filepath')
    .argument('<output>', 'output filepath')
    .action(async (input, output, arg) => {
        runner({
            version: 1,
            tasks: [
                { id: '0', type: 'Read', config: { inputs: [input], output: 'cache0' } },
                { id: '1', type: 'SkeletonLod', config: { input: 'cache0', output: 'cache0', ratio: arg.ratio } },
                { id: '2', type: 'Write', config: { input: 'cache0', output: output } },
            ],
        });
    });

program
    .command('lod:flex')
    .description('Generate flex-lod for gaussian splat file')
    .requiredOption('--score <string>')
    .option('--ratio <number>')
    .argument('<input>', 'input filepath')
    .argument('<output>', 'output filepath')
    .action(async (input, output, arg) => {
        runner({
            version: 1,
            tasks: [
                { id: '0', type: 'Read', config: { inputs: [input], output: 'cache0' } },
                { id: '1', type: 'FlexLod', config: { input: 'cache0', output: 'cache0', ratio: arg.ratio, scorePath: arg.score } },
                { id: '2', type: 'Write', config: { input: 'cache0', output: output } },
            ],
        });
    });

program
    .command('lod:auto')
    .description('Generate auto-lod for gaussian splat file')
    .option('--ratio <number>')
    .argument('<input>', 'input filepath')
    .argument('<output>', 'output filepath')
    .action(async (input, output, arg) => {
        runner({
            version: 1,
            tasks: [
                { id: '0', type: 'Read', config: { inputs: [input], output: 'cache0' } },
                { id: '1', type: 'AutoLod', config: { input: 'cache0', output: 'cache0', ratio: arg.ratio } },
                { id: '2', type: 'Write', config: { input: 'cache0', output: output } },
            ],
        });
    });

const fileTypeOption = program.createOption('-t, --type <type>', 'output file type').choices(['ply', 'spz', 'splat', 'sog']);
fileTypeOption.required = true;
program
    .command('lod:auto-chunk')
    .description('Generate auto-chunk-lod for gaussian splat file')
    .addOption(fileTypeOption)
    .option('--max-chunk-counts <number>')
    .argument('<input>', 'input filepath')
    .argument('<output>', 'output directory')
    .action(async (input, output, arg) => {
        runner({
            version: 1,
            tasks: [
                { id: '0', type: 'Read', config: { inputs: [input], output: 'cache0' } },
                { id: '1', type: 'AutoChunkLod', config: { input: 'cache0', output: 'cache0', type: arg.type, maxChunkCounts: arg.maxChunkCounts } },
                { id: '2', type: 'Write', config: { input: 'cache0', output: output } },
            ],
        });
    });

program.parse();
