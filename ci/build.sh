#!/usr/bin/env bash
set -e
npm install npm -g
npm install corepack -g
corepack enable
corepack install

pnpm install
pnpm build
