import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
    getPnpmCommand,
    isInsideDir,
    listFiles,
    readJsonFile,
    runCommandOrExit,
    workspaceRoot,
} from './package-utils.mjs';

const rootDir = workspaceRoot;
const egsRoot = join(rootDir, 'external/egs-core');

if (process.env.AHOLO_SKIP_EGS_TYPES === '1') {
    console.log('[egs-types] Skipping EGS type preparation because AHOLO_SKIP_EGS_TYPES=1.');
    process.exit(0);
}

runCommandOrExit(process.execPath, [join(rootDir, 'scripts/ensure-submodules.mjs')], {
    cwd: rootDir,
    label: 'node scripts/ensure-submodules.mjs',
});
ensureEgsInstall();

const packages = getEgsWorkspacePackages();
const builtPackages = new Set();

for (const pkg of packages) {
    const dependencyWasBuilt = pkg.workspaceDependencies.some(dependencyName => builtPackages.has(dependencyName));

    if (pkg.buildable && (dependencyWasBuilt || isStale(pkg))) {
        console.log(`[egs-types] Building declarations for ${pkg.name}.`);
        runTsc(pkg.dir, ['-p', 'tsconfig.json', '--emitDeclarationOnly']);
        builtPackages.add(pkg.name);
    }

    syncDeclarationAssets(pkg);

    if (!existsSync(pkg.declaration)) {
        console.error(`[egs-types] Missing declaration output for ${pkg.name}: ${pkg.declaration}`);
        process.exit(1);
    }
}

console.log('[egs-types] Ready.');

function getEgsWorkspacePackages() {
    const packagesByName = new Map();

    for (const dir of getWorkspacePackageDirs()) {
        if (!isInsideDir(egsRoot, dir)) {
            continue;
        }

        const packageJson = readJsonFile(join(dir, 'package.json'), 'EGS package metadata');
        const declaration = resolvePackageDeclaration(dir, packageJson);

        if (!packageJson.name || !declaration) {
            continue;
        }

        packagesByName.set(packageJson.name, {
            name: packageJson.name,
            dir,
            declaration,
            buildable: existsSync(join(dir, 'tsconfig.json')),
            packageJson,
            workspaceDependencies: [],
        });
    }

    for (const pkg of packagesByName.values()) {
        pkg.workspaceDependencies = getPackageDependencyNames(pkg.packageJson).filter(dependencyName =>
            packagesByName.has(dependencyName),
        );
    }

    const packages = sortPackagesByDependencies([...packagesByName.values()]);

    if (packages.length === 0) {
        console.error('[egs-types] No EGS workspace packages with declarations were found.');
        process.exit(1);
    }

    return packages;
}

function getWorkspacePackageDirs() {
    const result = runCommandOrExit(getPnpmCommand(), ['list', '--recursive', '--depth', '-1', '--json'], {
        cwd: rootDir,
        encoding: 'utf8',
        label: 'pnpm list --recursive --depth -1 --json',
        shell: process.platform === 'win32',
        stdio: 'pipe',
    });

    try {
        return JSON.parse(result.stdout)
            .map(workspacePackage => workspacePackage.path)
            .filter(Boolean);
    } catch (error) {
        console.error('[egs-types] Unable to parse pnpm workspace package list.');
        console.error(error);
        process.exit(1);
    }
}

function resolvePackageDeclaration(dir, packageJson) {
    const declaration = packageJson.types ?? packageJson.typings;

    if (!declaration) {
        return null;
    }

    const publishRoot = typeof packageJson.release?.publishRoot === 'string' ? packageJson.release.publishRoot : '.';

    return join(dir, publishRoot, declaration);
}

function getPackageDependencyNames(packageJson) {
    return [
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.devDependencies ?? {}),
        ...Object.keys(packageJson.peerDependencies ?? {}),
        ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];
}

function sortPackagesByDependencies(packages) {
    const packagesByName = new Map(packages.map(pkg => [pkg.name, pkg]));
    const sortedPackages = [];
    const visiting = new Set();
    const visited = new Set();

    for (const pkg of [...packages].sort(comparePackages)) {
        visit(pkg);
    }

    return sortedPackages;

    function visit(pkg) {
        if (visited.has(pkg.name)) {
            return;
        }

        if (visiting.has(pkg.name)) {
            console.error(`[egs-types] Circular EGS workspace dependency involving ${pkg.name}.`);
            process.exit(1);
        }

        visiting.add(pkg.name);

        for (const dependencyName of [...pkg.workspaceDependencies].sort()) {
            const dependency = packagesByName.get(dependencyName);

            if (dependency) {
                visit(dependency);
            }
        }

        visiting.delete(pkg.name);
        visited.add(pkg.name);
        sortedPackages.push(pkg);
    }
}

function comparePackages(left, right) {
    return left.name.localeCompare(right.name);
}

function syncDeclarationAssets(pkg) {
    const outputDir = dirname(pkg.declaration);

    for (const entry of readdirSync(pkg.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.d.ts')) {
            continue;
        }

        const sourcePath = join(pkg.dir, entry.name);
        const targetPath = join(outputDir, entry.name);

        if (resolve(sourcePath) === resolve(targetPath)) {
            continue;
        }

        if (!existsSync(targetPath) || statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs) {
            console.log(`[egs-types] Copying declaration asset for ${pkg.name}: ${entry.name}.`);
            copyFileSync(sourcePath, targetPath);
        }
    }
}

function ensureEgsInstall() {
    const requiredFiles = [
        join(egsRoot, 'node_modules/@internal/tsconfig/index.json'),
        join(egsRoot, 'node_modules/typescript/lib/tsc.js'),
    ];

    if (requiredFiles.every(file => existsSync(file))) {
        return;
    }

    console.log('[egs-types] Installing EGS build dependencies from external/egs-core/pnpm-lock.yaml.');
    runCommandOrExit(getPnpmCommand(), ['install', '--frozen-lockfile', '--ignore-scripts'], {
        cwd: egsRoot,
        label: 'pnpm install --frozen-lockfile --ignore-scripts',
        shell: process.platform === 'win32',
    });
}

function isStale(pkg) {
    if (!existsSync(pkg.declaration)) {
        return true;
    }

    const declarationMtime = statSync(pkg.declaration).mtimeMs;

    return getNewestSourceMtime(pkg.dir) > declarationMtime;
}

function getNewestSourceMtime(dir) {
    const sourceFiles = listFiles(dir, { skipDirectories: ['build', 'node_modules'] }).filter(
        filePath => filePath.endsWith('.ts') || filePath.endsWith('package.json') || filePath.endsWith('tsconfig.json'),
    );

    return sourceFiles.reduce((newest, filePath) => Math.max(newest, statSync(filePath).mtimeMs), 0);
}

function runTsc(cwd, args) {
    const tscPath = resolveTypescriptCompiler(cwd);
    runCommandOrExit(process.execPath, [tscPath, ...args], {
        cwd,
        label: `node ${tscPath} ${args.join(' ')}`,
    });
}

function resolveTypescriptCompiler(cwd) {
    const candidates = [
        join(cwd, 'node_modules/typescript/lib/tsc.js'),
        join(egsRoot, 'node_modules/typescript/lib/tsc.js'),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    console.error(`[egs-types] Unable to find TypeScript compiler for ${cwd}.`);
    process.exit(1);
}
