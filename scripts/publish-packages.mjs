import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

const publishDependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function resolveCatalogs() {
    const data = {};
    const result = {};
    let r = child_process
        .execSync('pnpm config get catalogs --location=project --json', { stdio: 'pipe' })
        .toString('utf-8');
    if (r) {
        Object.assign(data, JSON.parse(r));
    } else {
        r = child_process
            .execSync('pnpm config get catalog --location=project --json', { stdio: 'pipe' })
            .toString('utf-8');
        if (r) {
            Object.assign(data, JSON.parse(r));
        }
    }

    for (const key of Object.keys(data)) {
        if (typeof data[key] === 'string') {
            if (!result[key]) {
                result[key] = {};
            }
            result[key]['default'] = data[key];
        } else {
            const versions = data[key];
            for (const p of Object.keys(versions)) {
                if (!result[p]) {
                    result[p] = {};
                }
                result[p][`${key}`] = versions[p];
            }
        }
    }
    return result;
}

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

        // cleanup package.json before publish
        delete clonedPackageJson.scripts;
        delete clonedPackageJson.devDependencies;
        for (const field of publishDependencyFields) {
            const dependencies = clonedPackageJson[field];
            if (dependencies) {
                for (const p of Object.keys(dependencies)) {
                    if (dependencies[p].startsWith('catalog:')) {
                        const version = dependencies[p].slice('catalog:'.length) || 'default';
                        dependencies[p] = catalogs[p][version];
                    }
                }
            }
        }
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
