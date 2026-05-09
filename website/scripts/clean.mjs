import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanTargets = ['dist', '.astro', '.generated', 'src/content/api'];
const args = process.argv.slice(2);
const allowedArgs = new Set(['--dry-run']);
const unknownArgs = args.filter(arg => !allowedArgs.has(arg));
const dryRun = args.includes('--dry-run');

if (unknownArgs.length > 0) {
    throw new Error(`Unsupported clean argument(s): ${unknownArgs.join(', ')}`);
}

function resolveCleanTarget(target) {
    const targetPath = resolve(packageRoot, target);
    const relativePath = relative(packageRoot, targetPath);

    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Refusing to clean outside website package root: ${targetPath}`);
    }

    return targetPath;
}

for (const target of cleanTargets) {
    const targetPath = resolveCleanTarget(target);

    if (dryRun) {
        console.log(`[clean] would remove ${target}`);
        continue;
    }

    await rm(targetPath, { recursive: true, force: true });
    console.log(`[clean] removed ${target}`);
}
