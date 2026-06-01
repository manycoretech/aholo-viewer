#!/usr/bin/env bash
set -e
npm install npm -g
npm install corepack -g
corepack enable
corepack install

pnpm install
npm config set registry https://registry.npmjs.org
npm config set registry //registry.npmjs.org/:_authToken ${NPM_TOKEN}
node scripts/publish-packages.mjs
