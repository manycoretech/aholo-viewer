import path from 'node:path';
import fs from 'node:fs/promises';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { execCommand } from '@internal/utils/process.js';

const __dirname = import.meta.dirname;

async function build() {
    await fs.rm('./dist', { recursive: true, force: true });
    await execCommand('tsc', {
        env: {
            ...process.env,
            PATH: path.join(__dirname, '../node_modules/.bin') + path.delimiter + process.env.PATH,
        },
    }).promise;
}

await yargs(hideBin(process.argv))
    .scriptName('build')
    .showHelpOnFail(false)
    .strict()
    .command({
        command: ['build', '$0'],
        async handler() {
            await build();
        },
    })
    .parseAsync();
