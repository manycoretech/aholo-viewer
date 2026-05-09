import { rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
    assertInsideDir,
    readPackageJson,
    resolvePackagePath,
    resolvePackageRoot,
    toPosixPath,
} from './package-utils.mjs';

const packageRoot = resolvePackageRoot();
const packageJson = readPackageJson(packageRoot);
const packageName = packageJson.name ?? packageRoot;
const targetDirs = getCleanTargetDirs(packageJson).map(target =>
    resolvePackagePath(packageRoot, target, 'clean target'),
);

for (const targetDir of [...new Set(targetDirs.map(dir => resolve(dir)))]) {
    assertInsideDir(packageRoot, targetDir, 'Clean target');

    if (resolve(targetDir) === resolve(packageRoot)) {
        throw new Error(`Refusing to clean the package root: ${targetDir}`);
    }

    await rm(targetDir, { recursive: true, force: true });
    console.log(`[package-clean] Removed ${formatPackagePath(targetDir)} for ${packageName}.`);
}

function getCleanTargetDirs(metadata) {
    const configuredTargets = metadata.aholoClean?.targets;

    if (Array.isArray(configuredTargets) && configuredTargets.length > 0) {
        return configuredTargets;
    }

    const outputDirs = [metadata.main, metadata.module, metadata.types, metadata.typings]
        .filter(value => typeof value === 'string' && value.trim() !== '')
        .map(filePath => dirname(filePath))
        .filter(dir => dir !== '.');

    return outputDirs.length > 0 ? [...new Set(outputDirs)] : ['dist'];
}

function formatPackagePath(filePath) {
    return toPosixPath(relative(packageRoot, filePath));
}
