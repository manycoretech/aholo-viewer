#!/usr/bin/env node

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { start } from '../src/server.js';
import packageJson from '../package.json' with { type: 'json' }

const argv = yargs(hideBin(process.argv))
    .version(packageJson.version)
    .usage('splat-dev-server [options] <dir>')
    .option('address', {
        alias: 'a',
        type: 'string',
        default: '127.0.0.1',
        describe: 'Address to listen'
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        default: 3000,
        description: 'Port to listen'
    })
    .argv;

start(argv.address, argv.port, argv._[0]);
