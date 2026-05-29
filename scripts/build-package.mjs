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

const srcEntry = resolvePackagePath(packageRoot, packageJson.source ?? 'src/index.ts', 'source entry');
const runtimeOutput = resolvePackagePath(
    packageRoot,
    packageJson.module ?? packageJson.main ?? 'dist/index.js',
    'runtime output',
);
const declarationOutput = resolvePackagePath(
    packageRoot,
    packageJson.types ?? packageJson.typings ?? 'dist/index.d.ts',
    'declaration output',
);
const runtimeDir = dirname(runtimeOutput);
const declarationDir = dirname(declarationOutput);
const tempTypesDir = resolve(packageRoot, 'build');
const egsPackagesRoot = resolveWorkspacePath(
    packageJson.aholoBuild?.egsPackagesRoot ?? 'external/egs-core/packages',
    'EGS packages root',
);
const workerEntry = resolveWorkspacePath(
    packageJson.aholoBuild?.workerEntry ?? 'external/egs-core/packages/loaders/splat-loader/worker.ts',
    'splat worker entry',
);

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
        plugins: [splatLoaderPatchPlugin(), dracoLoaderPatchPlugin()],
    };

    await build({
        ...shared,
        entryPoints: [srcEntry],
        outfile: runtimeOutput,
    });

    await build({
        ...shared,
        entryPoints: [workerEntry],
        outfile: resolve(runtimeDir, 'splat-worker.js'),
    });
}

function emitPackageDeclarations(tsconfigPath) {
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
        bundledPackages: [
            '@qunhe/egs',
            '@qunhe/egs-animation',
            '@qunhe/egs-gltf-loader',
            '@qunhe/egs-draco-loader',
            '@qunhe/egs-splat-loader',
            '@qunhe/egs-splat-utils',
        ],
    });
    let content = await readFile(resolve(packageRoot, 'build/index.d.ts'), 'utf-8');
    const typeClasses = [];
    for (const { name, exported, unexported } of declareOnlyClasses) {
        if (content.indexOf(exported) !== -1) {
            content = content.replace(exported, unexported);
            typeClasses.push(name);
        }
    }
    if (typeClasses.length > 0) {
        content += `\nexport type {
    ${typeClasses.join(',\n    ')}
}\n`;
    }
    await writeFile(declarationOutput, content, 'utf-8');
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

function splatLoaderPatchPlugin() {
    return {
        name: 'aholo-splat-loader-patch',
        setup(buildContext) {
            buildContext.onLoad({ filter: /loaders[\\/]splat-loader[\\/]index\.ts$/ }, async args => {
                const source = await readFile(args.path, 'utf8');
                const contents = source.replace(
                    /let SplatWorkerFactor: \(\) => Worker;\s*try \{[\s\S]*?\};\s*const poll =/,
                    `let SplatWorkerFactor: () => Worker;
let SplatWorkerBlobUrl: string | undefined;
SplatWorkerFactor = () => {
    const workerUrl = new URL("./splat-worker.js", import.meta.url).href;

    if (!SplatWorkerBlobUrl) {
        const source = \`import \${JSON.stringify(workerUrl)};\`;
        SplatWorkerBlobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    }

    return new Worker(SplatWorkerBlobUrl, { type: "module" });
};
const poll =`,
                );

                return {
                    contents,
                    loader: 'ts',
                };
            });
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
