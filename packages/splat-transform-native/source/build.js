import path from 'node:path';
import { createRequire } from 'node:module';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { spawnProcess } from '@internal/utils/process.js';

const __dirname = import.meta.dirname;
const require = createRequire(import.meta.url);

await yargs(hideBin(process.argv))
    .scriptName('build')
    .showHelpOnFail(false)
    .strict()
    .command({
        command: ['build', '$0'],
        builder(argv) {
            argv.option('preset', {
                describe: 'CMake preset',
                default: 'default',
            }).option('target', {
                describe: 'Platform target',
                demandOption: true,
            });
        },
        async handler(argv) {
            await spawnProcess(
                'node',
                [
                    require.resolve('cmake-js/bin/cmake-js'),
                    'build',
                    `--CDBINDING_BINARY_DIR=${path.resolve(`../splat-transform-${argv.target}`)}`,
                    '--',
                    '--preset',
                    argv.preset,
                ],
                {
                    cwd: process.cwd(),
                    env: {
                        ...process.env,
                        FORCE_COLOR: 1,
                        PATH: path.join(__dirname, '.`/node_modules/.bin') + path.delimiter + process.env.PATH,
                    },
                },
            ).promise;
        },
    })
    .parseAsync();
