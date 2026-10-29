import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCatalogs, applyCatalogs } from '@internal/utils/catalogs.js';
import { getReleaseConfig } from './release-config.mjs';

const splatTransformName = '@manycore/aholo-splat-transform';

function isNativePackage(name) {
    return name.startsWith(`${splatTransformName}-`);
}

function isPublished(p) {
    try {
        child_process.execSync(`npm view ${p.name}@${p.version} version --json --registry=https://registry.npmjs.org`, {
            stdio: 'pipe',
        });
        return true;
    } catch (error) {
        let code;
        try {
            code = JSON.parse(error.stdout?.toString('utf-8') ?? '').error?.code;
        } catch {
            // Non-JSON failures must not be mistaken for an unpublished version.
        }
        if (code === 'E404') return false;
        throw new Error(`Unable to check npm publish status for ${p.name}@${p.version}${code ? ` (${code})` : ''}.`, {
            cause: error,
        });
    }
}

export function publishPackages({ planOnly = false, githubOutput = process.env.GITHUB_OUTPUT } = {}) {
    const packages = JSON.parse(
        child_process
            .execSync('pnpm list --filter=@manycore/* -r --depth -1 --json', { stdio: 'pipe' })
            .toString('utf-8'),
    ).filter(item => !item.private);
    const splatTransform = packages.find(p => p.name === splatTransformName);

    // Resolve effective versions without changing workspace manifests. Native packages
    // use the main package version, even though their checked-in version is 0.0.0.
    const releasePackages = packages.map(p => {
        const native = isNativePackage(p.name);
        if (native && !splatTransform) throw new Error(`Missing workspace package: ${splatTransformName}`);
        const version = native ? splatTransform.version : p.version;
        return { ...p, version, native, ...getReleaseConfig(version) };
    });
    const pendingPackages = releasePackages.filter(p => !isPublished(p));
    const nativePackages = pendingPackages.filter(p => p.native);

    console.log('Pending packages:');
    for (const p of pendingPackages) console.log(`\t${p.name}@${p.version}`);
    if (pendingPackages.length === 0) console.log('\t(none)');
    console.log(`Native artifacts required: ${nativePackages.length > 0}`);

    if (planOnly) {
        if (githubOutput) fs.appendFileSync(githubOutput, `needs_native=${nativePackages.length > 0}\n`);
        return pendingPackages;
    }

    // Check every required artifact before building, changing manifests, or publishing.
    // Already-published native packages do not need local artifacts.
    for (const p of nativePackages) {
        const executable = path.join(p.path, p.name.includes('-win32-') ? 'splat-transform.exe' : 'splat-transform');
        for (const artifact of [executable, path.join(p.path, 'THIRD_PARTY_LICENSES.txt')]) {
            const stat = fs.statSync(artifact, { throwIfNoEntry: false });
            if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing or empty native artifact: ${artifact}`);
        }
        // GitHub artifact downloads do not preserve Unix executable permissions.
        if (!p.name.includes('-win32-')) fs.chmodSync(executable, 0o755);
    }

    if (pendingPackages.length === 0) return [];
    const catalogs = resolveCatalogs();
    const publishedPackages = [];
    // Publish native dependencies before the CLI that references them. A retry then
    // needs artifacts only for the platform versions that are still unpublished.
    pendingPackages.sort((a, b) => Number(b.native) - Number(a.native));
    for (const p of pendingPackages) {
        const cwd = p.path;
        const packageJsonPath = path.join(cwd, 'package.json');
        const originalPackageJson = fs.readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(originalPackageJson);
        packageJson.version = p.version;
        if (p.name === splatTransformName) {
            for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
                if (isNativePackage(name)) packageJson.optionalDependencies[name] = p.version;
            }
        }
        if (packageJson.scripts?.['.build']) packageJson.scripts.build = 'pnpm run .build';

        try {
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, undefined, 2), 'utf-8');
            child_process.execSync('pnpm run --if-present build', { stdio: 'inherit', cwd });

            delete packageJson.scripts;
            delete packageJson.devDependencies;
            applyCatalogs(packageJson, ['dependencies', 'peerDependencies', 'optionalDependencies'], catalogs);
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, undefined, 2), 'utf-8');
            const publishCommand = p.prerelease
                ? `npm publish --access public --tag ${p.distTag}`
                : 'npm publish --access public';
            child_process.execSync(publishCommand, { stdio: 'inherit', cwd });
            publishedPackages.push({ name: p.name, version: p.version });
        } finally {
            fs.writeFileSync(packageJsonPath, originalPackageJson, 'utf-8');
        }
    }

    if (publishedPackages.length > 0) {
        console.log('published:');
        for (const p of publishedPackages) console.log(`\t${p.name}@${p.version}`);
    }
    return publishedPackages;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--plan')) {
        throw new Error('Usage: node scripts/publish-packages.mjs [--plan]');
    }
    publishPackages({ planOnly: args[0] === '--plan' });
}
