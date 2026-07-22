import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCatalogs, applyCatalogs } from '@internal/utils/catalogs.js';

const packages = JSON.parse(
    child_process.execSync('pnpm list --filter=@manycore/* -r -depth -1 --json', { stdio: 'pipe' }).toString('utf-8'),
).filter(item => !item.private);

// update splat-transform sub packages version.
{
    const splatTransformSubPackages = packages.filter(
        item =>
            item.name.startsWith('@manycore/aholo-splat-transform') && item.name !== '@manycore/aholo-splat-transform',
    );
    const splatTransformMainPackage = packages.find(item => item.name === '@manycore/aholo-splat-transform');
    const splatTransformMainPackageJson = JSON.parse(
        fs.readFileSync(path.resolve(splatTransformMainPackage.path, 'package.json'), 'utf-8'),
    );
    for (const p of splatTransformSubPackages) {
        const packageJson = JSON.parse(fs.readFileSync(path.resolve(p.path, 'package.json'), 'utf-8'));
        p.version = splatTransformMainPackageJson.version;
        packageJson.version = splatTransformMainPackageJson.version;
        splatTransformMainPackageJson.optionalDependencies[p.name] = splatTransformMainPackageJson.version;
        fs.writeFileSync(path.resolve(p.path, 'package.json'), JSON.stringify(packageJson, undefined, 2), 'utf-8');
    }
    fs.writeFileSync(
        path.resolve(splatTransformMainPackage.path, 'package.json'),
        JSON.stringify(splatTransformMainPackageJson, undefined, 2),
        'utf-8',
    );
}

const publishedPackages = [];

const catalogs = resolveCatalogs();

for (const p of packages) {
    const cwd = p.path;
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(cwd, 'package.json'), 'utf-8'));
    const hiddenBuildCommand = packageJson.scripts?.['.build'];
    let published = false;
    try {
        child_process.execSync(`npm view ${p.name}@${p.version}`, { stdio: 'ignore' });
        published = true;
    } catch {
        // assume not found. should publish.
    }
    if (!published) {
        const clonedPackageJson = structuredClone(packageJson);
        if (hiddenBuildCommand) {
            // hidden build command exists, add build commands to call .build
            clonedPackageJson.scripts.build = 'pnpm run .build';
            fs.writeFileSync(
                path.resolve(cwd, 'package.json'),
                JSON.stringify(clonedPackageJson, undefined, 2),
                'utf-8',
            );
        }
        // run build command if exists
        child_process.execSync('pnpm run --if-present build', { stdio: 'inherit', cwd });

        // cleanup & resolve package.json before publish
        delete clonedPackageJson.scripts;
        delete clonedPackageJson.devDependencies;
        applyCatalogs(clonedPackageJson, ['dependencies', 'peerDependencies', 'optionalDependencies'], catalogs);

        fs.writeFileSync(path.resolve(cwd, 'package.json'), JSON.stringify(clonedPackageJson, undefined, 2), 'utf-8');
        child_process.execSync('npm publish --access public', { stdio: 'inherit', cwd });
        // restore package.json
        fs.writeFileSync(path.resolve(cwd, 'package.json'), JSON.stringify(packageJson, undefined, 2), 'utf-8');
        publishedPackages.push({
            name: p.name,
            version: p.version,
        });
    }
}

if (publishedPackages.length > 0) {
    console.log('published:');
    for (const p of publishedPackages) {
        console.log(`\t${p.name}@${p.version}`);
    }
}
