import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCommand, runCommandOrExit, workspaceRoot } from './package-utils.mjs';

const rootDir = workspaceRoot;

if (process.env.AHOLO_SKIP_SUBMODULE_UPDATE === '1') {
    console.log('[submodules] Skipping because AHOLO_SKIP_SUBMODULE_UPDATE=1.');
    process.exit(0);
}

if (!existsSync(resolve(rootDir, '.git'))) {
    console.log('[submodules] Skipping submodule check outside a Git checkout.');
    process.exit(0);
}

const unrecordedSubmodules = listUnrecordedSubmoduleCommits();

if (unrecordedSubmodules.length > 0) {
    console.log('[submodules] Skipping update because these submodules have unrecorded commits:');

    for (const submodule of unrecordedSubmodules) {
        console.log(`  - ${submodule}`);
    }

    console.log('[submodules] Run git add <path> first if the parent repo should record these commits.');
    process.exit(0);
}

runCommandOrExit('git', ['submodule', 'update', '--init', '--recursive'], {
    cwd: rootDir,
    env: gitEnv(),
    label: 'git submodule update --init --recursive',
});

console.log('[submodules] Ready.');

function listUnrecordedSubmoduleCommits() {
    return listSubmodulePaths().filter(hasUnrecordedSubmoduleCommit);
}

function listSubmodulePaths() {
    if (!existsSync(resolve(rootDir, '.gitmodules'))) {
        return [];
    }

    const result = runCommandOrExit('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
        cwd: rootDir,
        encoding: 'utf8',
        env: gitEnv(),
        label: 'git config --file .gitmodules --get-regexp path',
        stdio: 'pipe',
    });

    return (result.stdout ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => line.replace(/^submodule\..*\.path\s+/, ''));
}

function hasUnrecordedSubmoduleCommit(submodulePath) {
    const result = runCommand('git', ['diff', '--quiet', '--ignore-submodules=dirty', '--', submodulePath], {
        cwd: rootDir,
        encoding: 'utf8',
        env: gitEnv(),
        stdio: 'pipe',
    });

    if (result.status === 0) {
        return false;
    }

    if (result.status === 1) {
        return true;
    }

    console.error(`[submodules] Unable to inspect submodule status: ${submodulePath}`);

    if (result.error) {
        console.error(result.error);
    }

    if (result.stderr) {
        console.error(result.stderr);
    }

    process.exit(result.status ?? 1);
}

function gitEnv() {
    const env = { ...process.env };
    const windowsOpenSsh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';

    if (process.platform === 'win32' && !env.GIT_SSH_COMMAND && existsSync(windowsOpenSsh)) {
        env.GIT_SSH_COMMAND = windowsOpenSsh.replaceAll('\\', '/');
    }

    return env;
}
