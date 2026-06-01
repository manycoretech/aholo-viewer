import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packages = JSON.parse(
    child_process.execSync('pnpm list --filter=@manycore/* -r -depth -1 --json', { stdio: 'pipe' }).toString('utf-8'),
).filter(item => !item.private);

for (const p of packages) {
    const cwd = p.path;
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(cwd, 'package.json')));
    const buildCommand = packageJson.scripts?.['.build'];
    let published = false;
    try {
        child_process.execSync(`npm view ${p.name}@${p.version}`, { stdio: 'ignore' });
        published = true;
    } catch {
        // assume not found. should publish.
    }
    if (!published) {
        if (buildCommand) {
            child_process.execSync(buildCommand, { stdio: 'inherit', cwd });
        }
        child_process.execSync('npm pkg delete scripts devDependencies', { stdio: 'inherit', cwd });
        child_process.execSync('npm publish --access public', { stdio: 'inherit', cwd });
    }
}
