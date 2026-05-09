import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolvePackageRoot(packageRootArg = process.argv[2]) {
    const packageRoot = resolve(process.cwd(), packageRootArg ?? '.');
    assertInsideDir(workspaceRoot, packageRoot, 'Package root');

    const packageJsonPath = resolve(packageRoot, 'package.json');

    if (!existsSync(packageJsonPath)) {
        throw new Error(`Package root is missing package.json: ${packageRoot}`);
    }

    return packageRoot;
}

export function readPackageJson(packageRoot) {
    return readJsonFile(resolve(packageRoot, 'package.json'), 'package metadata');
}

export function readJsonFile(filePath, label = 'JSON') {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Unable to read ${label} at ${filePath}.`, { cause: error });
    }
}

export function resolvePackagePath(packageRoot, value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Missing ${label}.`);
    }

    const absolutePath = resolve(packageRoot, value);
    assertInsideDir(packageRoot, absolutePath, label);
    return absolutePath;
}

export function resolveWorkspacePath(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Missing ${label}.`);
    }

    const absolutePath = resolve(workspaceRoot, value);
    assertInsideDir(workspaceRoot, absolutePath, label);
    return absolutePath;
}

export function assertInsideDir(parent, child, label) {
    if (!isInsideDir(parent, child)) {
        throw new Error(`${label} must stay inside ${parent}: ${child}`);
    }
}

export function isInsideDir(parent, child) {
    const relativePath = relative(resolve(parent), resolve(child));

    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function formatWorkspacePath(filePath) {
    return toPosixPath(relative(workspaceRoot, resolve(filePath)));
}

export function statSafe(filePath) {
    try {
        return statSync(filePath);
    } catch {
        return undefined;
    }
}

export function listFiles(directory, options = {}) {
    if (!existsSync(directory)) {
        return [];
    }

    const files = [];
    const skipDirectories = new Set(options.skipDirectories ?? []);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && skipDirectories.has(entry.name)) {
            continue;
        }

        const entryPath = resolve(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listFiles(entryPath, options));
            continue;
        }

        if (entry.isFile()) {
            files.push(entryPath);
        }
    }

    return files;
}

export function readWebsiteLocales() {
    const localeSourcePath = resolve(workspaceRoot, 'website/src/i18n/locales.ts');
    const source = readFileSync(localeSourcePath, 'utf8');
    const localeMatches = [...source.matchAll(/code:\s*["']([^"']+)["']/g)].map(match => match[1]);

    if (localeMatches.length === 0) {
        throw new Error(`Unable to read website locales from ${formatWorkspacePath(localeSourcePath)}.`);
    }

    return localeMatches;
}

export function getPnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function runCommand(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: options.cwd ?? workspaceRoot,
        encoding: options.encoding,
        env: options.env ?? process.env,
        shell: options.shell ?? false,
        stdio: options.stdio ?? 'inherit',
    });
}

export function runCommandOrExit(command, args, options = {}) {
    const result = runCommand(command, args, options);

    if (result.status === 0) {
        return result;
    }

    const cwd = options.cwd ?? workspaceRoot;
    const label = options.label ?? `${command} ${args.join(' ')}`;

    console.error(`[scripts] Command failed in ${cwd}: ${label}`);

    if (result.error) {
        console.error(result.error);
    }

    if (result.stderr) {
        console.error(result.stderr);
    }

    process.exit(result.status ?? 1);
}

export function toPosixPath(value) {
    return value.replace(/\\/g, '/');
}
