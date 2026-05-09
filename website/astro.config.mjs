import { defineConfig } from 'astro/config';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assetsPrefix,
    astroAssetsDir,
    buildHashLength,
    getManualAssetOutputPath,
    manualAssetsDir,
    manualAssetPath,
} from './src/utils/manual-assets.js';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const manualContentRoot = fileURLToPath(new URL('./src/content/manual', import.meta.url));
const manualAssetSourceRoot = fileURLToPath(new URL('./src/content/manual/assets', import.meta.url));
const manualBuildAssetRoot = fileURLToPath(new URL(`./dist/${astroAssetsDir}/${manualAssetsDir}`, import.meta.url));
const manualDevAssetPath = manualAssetPath;
const examplesContentRoot = fileURLToPath(new URL('./src/content/examples', import.meta.url));
const rollupOutputFileNames = {
    entryFileNames: `${astroAssetsDir}/[name].[hash:${buildHashLength}].js`,
    chunkFileNames: `${astroAssetsDir}/[name].[hash:${buildHashLength}].js`,
    assetFileNames: `${astroAssetsDir}/[name].[hash:${buildHashLength}][extname]`,
};
const egsCoreWatchRoots = [
    fileURLToPath(new URL('../external/egs-core/packages', import.meta.url)),
    fileURLToPath(new URL('../external/egs-core/tools/utils', import.meta.url)),
];
const contentReloadEvents = ['add', 'change', 'unlink'];
const manualInvalidationRules = {
    includes: ['/src/content/manual/', '/src/pages/[lang]/manual/'],
    endsWith: ['/src/utils/manual.ts'],
};
const examplesInvalidationRules = {
    includes: ['/src/content/examples/', '/src/pages/[lang]/examples/'],
    endsWith: [
        '/src/components/PlaygroundShell.astro',
        '/src/pages/[lang]/index.astro',
        '/src/pages/[lang]/playground.astro',
        '/src/utils/examples.ts',
    ],
};
const rendererInvalidationRules = {
    includes: ['/packages/renderer/dist/', '/node_modules/@manycore/aholo-viewer/', '@manycore/aholo-viewer'],
    endsWith: ['/packages/renderer/dist/index.js', '/packages/renderer/dist/splat-worker.js'],
};

export default defineConfig({
    output: 'static',
    trailingSlash: 'always',
    build: {
        assets: astroAssetsDir,
        assetsPrefix,
    },
    vite: {
        build: {
            rollupOptions: {
                output: rollupOutputFileNames,
            },
        },
        worker: {
            rollupOptions: {
                output: rollupOutputFileNames,
            },
        },
        server: {
            watch: {
                interval: 250,
                usePolling: true,
            },
        },
        optimizeDeps: {
            exclude: ['monaco-editor', '@manycore/aholo-viewer'],
        },
        environments: {
            client: {
                build: {
                    rollupOptions: {
                        output: rollupOutputFileNames,
                    },
                },
            },
        },
        plugins: [
            manualAssetsPlugin(),
            manualContentReloadPlugin(),
            examplesContentReloadPlugin(),
            egsCoreReloadPlugin(),
        ],
    },
});

function manualAssetsPlugin() {
    return {
        name: 'aholo-manual-assets',
        configureServer(server) {
            server.watcher.add(manualAssetSourceRoot);
            server.middlewares.use(manualDevAssetPath, async (request, response, next) => {
                try {
                    const requestedPath = getManualAssetRequestPath(request.url);

                    if (!requestedPath) {
                        next();
                        return;
                    }

                    const assetPath = resolve(manualAssetSourceRoot, requestedPath);

                    if (!isWithinRoot(manualAssetSourceRoot, assetPath)) {
                        next();
                        return;
                    }

                    const assetStat = await stat(assetPath);

                    if (!assetStat.isFile()) {
                        next();
                        return;
                    }

                    response.statusCode = 200;
                    response.setHeader('Content-Type', getContentType(assetPath));
                    createReadStream(assetPath).pipe(response);
                } catch {
                    next();
                }
            });
        },
        async closeBundle() {
            if (!existsSync(manualAssetSourceRoot)) {
                return;
            }

            await rm(manualBuildAssetRoot, { recursive: true, force: true });
            await copyManualBuildAssets(manualAssetSourceRoot);
        },
    };
}

async function copyManualBuildAssets(root, currentDir = root) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const sourcePath = resolve(currentDir, entry.name);

        if (entry.isDirectory()) {
            await copyManualBuildAssets(root, sourcePath);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativeAssetPath = toPosixPath(relative(root, sourcePath));
        const outputAssetPath = getManualAssetOutputPath(relativeAssetPath, sourcePath, { hash: true });
        const buildAssetPath = resolve(manualBuildAssetRoot, outputAssetPath);

        await mkdir(dirname(buildAssetPath), { recursive: true });
        await copyFile(sourcePath, buildAssetPath);
    }
}

function manualContentReloadPlugin() {
    return contentReloadPlugin({
        name: 'aholo-manual-content-reload',
        root: manualContentRoot,
        shouldReload: isManualMarkdown,
        invalidate: invalidateManualModules,
        notify: [sendFullReload],
    });
}

function examplesContentReloadPlugin() {
    return contentReloadPlugin({
        name: 'aholo-examples-content-reload',
        root: examplesContentRoot,
        shouldReload: isExampleContent,
        invalidate: invalidateExampleModules,
        notify: [sendContentChanged, sendFullReload],
    });
}

function egsCoreReloadPlugin() {
    let rebuildTimer;
    let rebuildRunning = false;
    let rebuildQueued = false;

    return {
        name: 'aholo-egs-core-reload',
        apply: 'serve',
        configureServer(server) {
            server.watcher.setMaxListeners(Math.max(server.watcher.getMaxListeners(), 20));
            server.watcher.add(egsCoreWatchRoots.filter(root => existsSync(root)));

            const scheduleRebuild = file => {
                if (!isEgsCoreDevSource(file)) {
                    return;
                }

                clearTimeout(rebuildTimer);
                rebuildTimer = setTimeout(() => {
                    rebuildTimer = undefined;
                    void rebuildRendererFromEgs(server);
                }, 250);
            };

            for (const eventName of contentReloadEvents) {
                server.watcher.on(eventName, scheduleRebuild);
            }
        },
    };

    async function rebuildRendererFromEgs(server) {
        if (rebuildRunning) {
            rebuildQueued = true;
            return;
        }

        rebuildRunning = true;

        try {
            do {
                rebuildQueued = false;
                console.log('[egs-dev] EGS source changed. Rebuilding renderer.');
                await runWorkspaceScript('.egs:types');
                await runWorkspaceScript('.renderer:build');
            } while (rebuildQueued);

            invalidateRendererModules(server);
            sendFullReload(server);
            console.log('[egs-dev] Renderer rebuild complete. Site reloaded.');
        } catch (error) {
            console.error('[egs-dev] Renderer rebuild failed. Fix the error and save again to retry.');
            console.error(error);
        } finally {
            rebuildRunning = false;

            if (rebuildQueued) {
                void rebuildRendererFromEgs(server);
            }
        }
    }
}

function contentReloadPlugin({ name, root, shouldReload, invalidate, notify }) {
    return {
        name,
        configureServer(server) {
            server.watcher.setMaxListeners(Math.max(server.watcher.getMaxListeners(), 20));
            server.watcher.add(root);

            const reload = file => {
                if (!shouldReload(file)) {
                    return;
                }

                invalidate(server);

                for (const send of notify) {
                    send(server);
                }
            };

            for (const eventName of contentReloadEvents) {
                server.watcher.on(eventName, reload);
            }
        },
    };
}

function invalidateManualModules(server) {
    invalidateModules(server, id => matchesRule(id, manualInvalidationRules));
}

function invalidateExampleModules(server) {
    invalidateModules(server, id => matchesRule(id, examplesInvalidationRules));
}

function invalidateRendererModules(server) {
    invalidateModules(server, id => matchesRule(id, rendererInvalidationRules));
}

function invalidateModules(server, shouldInvalidate) {
    const invalidatedModules = new Set();
    const timestamp = Date.now();

    for (const moduleGraph of getModuleGraphs(server)) {
        for (const moduleNode of getModuleNodes(moduleGraph)) {
            const id = toPosixPath(moduleNode.id ?? moduleNode.url ?? '');

            if (!id || !shouldInvalidate(id) || invalidatedModules.has(moduleNode)) {
                continue;
            }

            moduleGraph.invalidateModule(moduleNode, undefined, timestamp, true);
            invalidatedModules.add(moduleNode);
        }
    }
}

function getModuleGraphs(server) {
    const moduleGraphs = [];
    const environments = server.environments ? Object.values(server.environments) : [];

    for (const environment of environments) {
        if (environment?.moduleGraph && !moduleGraphs.includes(environment.moduleGraph)) {
            moduleGraphs.push(environment.moduleGraph);
        }
    }

    if (server.moduleGraph && !moduleGraphs.includes(server.moduleGraph)) {
        moduleGraphs.push(server.moduleGraph);
    }

    return moduleGraphs;
}

function getModuleNodes(moduleGraph) {
    if (moduleGraph.idToModuleMap) {
        return moduleGraph.idToModuleMap.values();
    }

    if (moduleGraph.urlToModuleMap) {
        return moduleGraph.urlToModuleMap.values();
    }

    return [];
}

function matchesRule(value, rule) {
    const matchesInclude = rule.includes.some(pattern => value.includes(pattern));
    const matchesSuffix = rule.endsWith.some(pattern => value.endsWith(pattern));

    return matchesInclude || matchesSuffix;
}

function sendContentChanged(server) {
    server.environments?.ssr?.hot?.send('astro:content-changed', {});
}

function sendFullReload(server) {
    const payload = { type: 'full-reload', path: '*' };

    if (server.environments?.client?.hot) {
        server.environments.client.hot.send(payload);
        return;
    }

    server.ws.send(payload);
}

function isManualMarkdown(file) {
    const normalized = toPosixPath(file);

    return normalized.includes('/src/content/manual/') && normalized.endsWith('.md');
}

function isExampleContent(file) {
    const normalized = toPosixPath(file);

    return normalized.includes('/src/content/examples/') && ['.json', '.ts'].includes(extname(normalized));
}

function isEgsCoreDevSource(file) {
    if (!file) {
        return false;
    }

    const normalized = toPosixPath(file);

    if (
        normalized.includes('/build/') ||
        normalized.includes('/dist/') ||
        normalized.includes('/node_modules/') ||
        !egsCoreWatchRoots.some(root => isWithinRoot(root, file))
    ) {
        return false;
    }

    return (
        normalized.endsWith('.ts') ||
        normalized.endsWith('.tsx') ||
        normalized.endsWith('/package.json') ||
        normalized.endsWith('/tsconfig.json')
    );
}

function runWorkspaceScript(scriptName) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(getPnpmCommand(), ['run', scriptName], {
            cwd: workspaceRoot,
            shell: process.platform === 'win32',
            stdio: 'inherit',
        });
        let settled = false;

        const finish = error => {
            if (settled) {
                return;
            }

            settled = true;

            if (error) {
                rejectRun(error);
                return;
            }

            resolveRun();
        };

        child.on('error', finish);
        child.on('close', (code, signal) => {
            if (code === 0) {
                finish();
                return;
            }

            finish(new Error(`pnpm run ${scriptName} failed with ${signal ?? `exit code ${code}`}.`));
        });
    });
}

function getPnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function toPosixPath(value) {
    return value.replace(/\\/g, '/');
}

function getManualAssetRequestPath(url) {
    let pathname = new URL(url ?? '/', 'http://localhost').pathname;

    if (pathname.startsWith(`${manualDevAssetPath}/`)) {
        pathname = pathname.slice(manualDevAssetPath.length);
    }

    return decodeURIComponent(pathname).replace(/^\/+/, '') || undefined;
}

function isWithinRoot(root, filePath) {
    const relativePath = relative(root, filePath);

    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function getContentType(filePath) {
    switch (extname(filePath).toLowerCase()) {
        case '.gif':
            return 'image/gif';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.svg':
            return 'image/svg+xml';
        case '.webp':
            return 'image/webp';
        default:
            return 'application/octet-stream';
    }
}
