import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from '@internal/utils/dts-rollup.js';
import {
    readJsonFile,
    readPackageJson,
    workspaceRoot,
    listFiles,
    resolvePackagePath,
    resolvePackageRoot,
    resolveWorkspacePath,
    runCommandOrExit,
    toPosixPath,
} from './package-utils.mjs';

const packageRoot = resolvePackageRoot();
const packageJson = readPackageJson(packageRoot);
const packageName = packageJson.name ?? packageRoot;
const packageRequire = createRequire(resolve(packageRoot, 'package.json'));
const { build } = await importPackageDependency('esbuild');

const srcEntries = [resolvePackagePath(packageRoot, 'src/index.ts', 'source entry')];
const runtimeDir = resolvePackagePath(packageRoot, 'dist', 'runtime output');
const declarationOutput = resolvePackagePath(packageRoot, 'dist/index.d.ts', 'declaration output');
const declarationDir = dirname(declarationOutput);
const tempTypesDir = resolve(packageRoot, 'build');
const egsPackagesRoot = resolveWorkspacePath('external/egs-core/packages', 'EGS packages root');
const workerBundles = [
    createWorkerBundle({
        entry: 'external/egs-core/packages/loaders/splat-loader/worker.ts',
        entryLabel: 'splat worker entry',
        fileName: 'splat-worker.js',
        factorySourceFilter: /loaders[\\/]splat-loader[\\/]index\.ts$/,
        factoryName: 'WorkerFactor',
        blobUrlName: 'SplatWorkerBlobUrl',
        nextStatement: 'const poll =',
    }),
    createWorkerBundle({
        entry: 'external/egs-core/packages/loaders/texture-loader/ktx2/basis/worker/transcoder.worker.ts',
        entryLabel: 'texture transcoder worker entry',
        fileName: 'transcoder-worker.js',
        factorySourceFilter: /loaders[\\/]texture-loader[\\/]ktx2[\\/]basis[\\/]worker[\\/]pool\.ts$/,
        factoryName: 'WorkerFactor',
        blobUrlName: 'TranscoderWorkerBlobUrl',
        nextStatement: 'const pool =',
    }),
    createWorkerBundle({
        entry: 'external/egs-core/packages/utils/splat-utils/worker.ts',
        entryLabel: 'splat sort worker entry',
        fileName: 'splat-sort-worker.js',
        factorySourceFilter: /utils[\\/]splat-utils[\\/]sort\.ts$/,
        factoryName: 'WorkerFactor',
        blobUrlName: 'SplatSortWorkerBlobUrl',
        nextStatement: 'const poll =',
    }),
];

const declareOnlyClasses = [
    { name: 'Viewer', exported: 'export declare class Viewer', unexported: 'declare class Viewer' },
    { name: 'Viewport', exported: 'export declare class Viewport', unexported: 'declare class Viewport' },
    {
        name: 'Material',
        exported: 'export declare abstract class Material',
        unexported: 'declare abstract class Material',
    },
    { name: 'Light', exported: 'export declare abstract class Light', unexported: 'declare abstract class Light' },
];

await mkdir(runtimeDir, { recursive: true });
await mkdir(declarationDir, { recursive: true });
await rm(tempTypesDir, { recursive: true, force: true });
await mkdir(tempTypesDir, { recursive: true });

await bundleRuntime();
emitPackageDeclarations();
await bundleDeclarations();
await stripPrivateTypingsImports();
await rm(tempTypesDir, { recursive: true, force: true });

console.log(`[package-build] Built ${packageName}.`);

async function importPackageDependency(name) {
    try {
        const resolvedPath = packageRequire.resolve(name);

        return await import(pathToFileURL(resolvedPath).href);
    } catch (error) {
        throw new Error(`Unable to load ${name} from ${packageName}. Is it listed in that package's dependencies?`, {
            cause: error,
        });
    }
}

async function bundleRuntime() {
    const shared = {
        absWorkingDir: packageRoot,
        bundle: true,
        format: 'esm',
        logLevel: 'info',
        minify: false,
        platform: 'browser',
        sourcemap: true,
        target: 'es2020',
        treeShaking: true,
        loader: {
            '.jpg': 'dataurl',
            '.png': 'dataurl',
        },
        plugins: [workerBundlePatchPlugin(workerBundles), textureLoaderPatchPlugin(), dracoLoaderPatchPlugin()],
    };

    await build({
        ...shared,
        entryPoints: srcEntries,
        outdir: runtimeDir,
    });

    for (const workerBundle of workerBundles) {
        await build({
            ...shared,
            entryPoints: [workerBundle.entry],
            outfile: resolve(runtimeDir, workerBundle.fileName),
        });
    }
}

function emitPackageDeclarations() {
    runCommandOrExit(
        process.execPath,
        [
            packageRequire.resolve('typescript/bin/tsc'),
            '--emitDeclarationOnly',
            '--declarationMap',
            'false',
            '--outDir',
            toPosixPath(tempTypesDir),
        ],
        {
            cwd: packageRoot,
            label: 'tsc --emitDeclarationOnly',
        },
    );
}

async function bundleDeclarations() {
    rollup(packageRoot, {
        typeOnlyExports: [
            { name: 'Viewer', type: 'class', abstract: false },
            { name: 'Viewport', type: 'class', abstract: false },
            { name: 'Material', type: 'class', abstract: true },
            { name: 'Light', type: 'class', abstract: true },
        ],
        extractorConfig: {
            bundledPackages: [
                '@qunhe/egs',
                '@qunhe/egs-animation',
                '@qunhe/egs-texture-loader',
                '@qunhe/egs-gltf-loader',
                '@qunhe/egs-draco-loader',
                '@qunhe/egs-splat-loader',
                '@qunhe/egs-splat-utils',
                '@qunhe/egs-xr',
                '@qunhe/egs-lib',
            ],
        },
    });
    await cp(resolve(packageRoot, 'build/index.d.ts'), declarationOutput, { force: true });
}

async function stripPrivateTypingsImports() {
    const source = await readFile(declarationOutput, 'utf8');
    const rewritten = source.replace(/^\s*import\s+type\s+\{\s*\}\s+from\s+["']@qunhe\/egs-typings["'];?\r?\n?/gm, '');

    if (rewritten !== source) {
        await writeFile(declarationOutput, rewritten);
    }
}

function getPackageJsonPaths(dir) {
    return listFiles(dir, { skipDirectories: ['build', 'dist', 'node_modules'] }).filter(
        filePath => basename(filePath) === 'package.json',
    );
}

function isInsidePackage(filePath) {
    const relativePath = relative(packageRoot, filePath);

    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function getInheritedConfigPaths(configPaths, fallbackPaths) {
    const paths = Array.isArray(configPaths) && configPaths.length > 0 ? configPaths : fallbackPaths;

    return paths.map(configPath => toRelativeConfigPath(relative(tempTypesDir, resolve(packageRoot, configPath))));
}

function toRelativeConfigPath(filePath) {
    const posixPath = toPosixPath(filePath) || '.';

    return posixPath.startsWith('.') ? posixPath : `./${posixPath}`;
}

function replaceExtension(filePath, replacementExtension) {
    const currentExtension = extname(filePath);

    return currentExtension
        ? `${filePath.slice(0, -currentExtension.length)}${replacementExtension}`
        : `${filePath}${replacementExtension}`;
}

function sanitizePathSegment(value) {
    return value
        .replace(/^@/, '')
        .replace(/[\\/]/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '-');
}

function splitNamedSpecifiers(specifierText) {
    return specifierText
        .split(',')
        .map(specifier => specifier.trim())
        .filter(Boolean);
}

function getNamedSpecifierName(specifier) {
    return removeTypeModifier(specifier)
        .split(/\s+as\s+/u)[0]
        .trim();
}

function removeTypeModifier(specifier) {
    return specifier.replace(/^type\s+/u, '').trim();
}

function createWorkerBundle(config) {
    return {
        ...config,
        entry: resolveWorkspacePath(config.entry, config.entryLabel),
    };
}

function workerBundlePatchPlugin(workerBundles) {
    return {
        name: 'aholo-worker-bundle-patch',
        setup(buildContext) {
            for (const workerBundle of workerBundles) {
                buildContext.onLoad({ filter: workerBundle.factorySourceFilter }, async args => {
                    const source = await readFile(args.path, 'utf8');
                    const contents = replaceWorkerFactory(source, workerBundle);

                    if (contents === source) {
                        throw new Error(`Unable to patch ${workerBundle.entryLabel}.`);
                    }

                    return {
                        contents,
                        loader: 'ts',
                    };
                });
            }
        },
    };
}

function replaceWorkerFactory(source, workerBundle) {
    const factoryPattern = createWorkerFactoryPattern(workerBundle.factoryName, workerBundle.nextStatement);

    return source.replace(factoryPattern, createWorkerFactoryReplacement(workerBundle));
}

function createWorkerFactoryPattern(factoryName, nextStatement) {
    return new RegExp(
        `let ${escapeRegExp(factoryName)}: \\(\\) => Worker;\\s*try \\{[\\s\\S]*?\\};?\\s*${escapeRegExp(nextStatement)}`,
    );
}

function createWorkerFactoryReplacement({ factoryName, blobUrlName, fileName, nextStatement }) {
    return `let ${factoryName}: () => Worker;
let ${blobUrlName}: string | undefined;
${factoryName} = () => {
    const workerUrl = new URL("./${fileName}", import.meta.url).href;

    if (!${blobUrlName}) {
        const source = \`import \${JSON.stringify(workerUrl)};\`;
        ${blobUrlName} = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    }

    return new Worker(${blobUrlName}, { type: "module" });
};
${nextStatement}`;
}

function textureLoaderPatchPlugin() {
    return {
        name: 'aholo-texture-loader-patch',
        setup(buildContext) {
            buildContext.onLoad(
                { filter: /loaders[\\/]texture-loader[\\/]ktx2[\\/]basis[\\/]wasm[\\/]basis_transcoder\.js$/ },
                async args => {
                    const source = await readFile(args.path, 'utf8');
                    const nodeBranchShim =
                        'var fs={readFileSync:function(){throw new Error("Node file loading is not available in the browser build.");}};';
                    const contents = source.replace(/var fs=require\("fs"\);/, nodeBranchShim);

                    if (contents === source) {
                        throw new Error('Unable to patch basis_transcoder.js node file-system branch.');
                    }

                    return {
                        contents,
                        loader: 'js',
                    };
                },
            );
        },
    };
}

function dracoLoaderPatchPlugin() {
    return {
        name: 'aholo-draco-loader-patch',
        setup(buildContext) {
            buildContext.onResolve({ filter: /draco_decoder\.wasm$/ }, args => ({
                path: resolve(dirname(args.importer), 'draco_decoder.wasm.js'),
            }));

            buildContext.onLoad({ filter: /draco_decoder_wrapper\.js$/ }, async args => {
                const source = await readFile(args.path, 'utf8');
                const nodeBranchShim = `var Za={readFileSync:function(){throw new Error("Node file loading is not available in the browser build.");},readFile:function(e,b,c){c(new Error("Node file loading is not available in the browser build."));}},qa={dirname:function(){return""},normalize:function(e){return e}};`;
                const contents = source.replace(/var Za=require\("fs"\),qa=require\("path"\);/, nodeBranchShim);

                if (contents === source) {
                    throw new Error('Unable to patch draco_decoder_wrapper.js node file-system branch.');
                }

                return {
                    contents,
                    loader: 'js',
                };
            });
        },
    };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
