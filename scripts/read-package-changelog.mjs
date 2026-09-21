import child_process from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertInsideDir, formatWorkspacePath, readPackageJson, resolveWorkspacePath } from './package-utils.mjs';

const [packageName, versionArg] = process.argv.slice(2);

if (!packageName) {
    console.error('Usage: node scripts/read-package-changelog.mjs <package-name> [version]');
    process.exit(1);
}

const packageInfo = JSON.parse(
    child_process.execSync('pnpm list --filter=@manycore/* -r --depth -1 --json', { stdio: 'pipe' }).toString('utf-8'),
).find(item => item.name === packageName);

const packageRoot = resolveWorkspacePath(packageInfo.path, 'Package root');
const packageJson = readPackageJson(packageRoot);
const packageVersion = versionArg ?? packageJson.version;

if (typeof packageVersion !== 'string' || packageVersion.trim() === '') {
    throw new Error(`Missing package version for ${formatWorkspacePath(packageRoot)}.`);
}

const changelogPath = resolve(packageRoot, 'CHANGELOG.md');
assertInsideDir(packageRoot, changelogPath, 'Changelog path');

if (!existsSync(changelogPath)) {
    throw new Error(`Missing CHANGELOG.md for ${formatWorkspacePath(packageRoot)}.`);
}

const changelog = readFileSync(changelogPath, 'utf8');
const body = readChangelogSection(changelog, packageVersion, formatWorkspacePath(changelogPath));

process.stdout.write(body);

function readChangelogSection(changelog, version, changelogLabel) {
    const versionHeading = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s.*)?$`, 'm');
    const match = versionHeading.exec(changelog);

    if (!match) {
        throw new Error(`Missing ${version} section in ${changelogLabel}.`);
    }

    const sectionStart = match.index + match[0].length;
    const rest = changelog.slice(sectionStart);
    const nextSection = /^##\s+/m.exec(rest);
    const body = (nextSection ? rest.slice(0, nextSection.index) : rest).trim();

    if (!body) {
        throw new Error(`Empty ${version} section in ${changelogLabel}.`);
    }

    return body;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
