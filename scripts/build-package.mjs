import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const { rollup } = await importPackageDependency('rollup');
const dtsModule = await importPackageDependency('rollup-plugin-dts');
const dts = dtsModule.dts ?? dtsModule.default?.dts ?? dtsModule.default;

if (typeof dts !== 'function') {
    throw new Error('Unable to load rollup-plugin-dts from the package dependencies.');
}

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
const tempTypesDir = resolve(declarationDir, '.types');
const egsPackagesRoot = resolveWorkspacePath(
    packageJson.aholoBuild?.egsPackagesRoot ?? 'external/egs-core/packages',
    'EGS packages root',
);
const workerEntry = resolveWorkspacePath(
    packageJson.aholoBuild?.workerEntry ?? 'external/egs-core/packages/loaders/splat-loader/worker.ts',
    'splat worker entry',
);
const externalSourceEntries = getExternalSourceEntries();
const vendorPackages = getEgsRuntimePackages();

await mkdir(runtimeDir, { recursive: true });
await mkdir(declarationDir, { recursive: true });
await rm(tempTypesDir, { recursive: true, force: true });
await mkdir(tempTypesDir, { recursive: true });

await bundleRuntime();
emitExternalSourceDeclarations();
const declarationTsconfig = await writeDeclarationTsconfig();
emitPackageDeclarations(declarationTsconfig);
await rewriteCircularEgsDeclarationImports();
await bundleDeclarations(declarationTsconfig);
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
        plugins: [externalSourcePlugin(), vendorAliasPlugin(), splatLoaderPatchPlugin(), dracoLoaderPatchPlugin()],
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
            '-p',
            toPosixPath(tsconfigPath),
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

async function bundleDeclarations(tsconfigPath) {
    const bundle = await rollup({
        input: resolve(tempTypesDir, 'index.d.ts'),
        plugins: [
            dts({
                tsconfig: tsconfigPath,
            }),
        ],
    });

    await bundle.write({
        file: declarationOutput,
        format: 'es',
    });
    await bundle.close();
}

function emitExternalSourceDeclarations() {
    for (const alias of externalSourceEntries) {
        runCommandOrExit(
            process.execPath,
            [
                packageRequire.resolve('typescript/bin/tsc'),
                '-p',
                toPosixPath(alias.tsconfigPath),
                '--emitDeclarationOnly',
                '--declarationMap',
                'false',
                '--outDir',
                toPosixPath(alias.typesDir),
            ],
            {
                cwd: alias.packageRoot,
                label: `tsc --emitDeclarationOnly (${alias.specifier})`,
            },
        );
    }
}

async function writeDeclarationTsconfig() {
    if (externalSourceEntries.length === 0) {
        return resolve(packageRoot, 'tsconfig.json');
    }

    const packageTsconfigPath = resolve(packageRoot, 'tsconfig.json');
    const packageTsconfig = readJsonFile(packageTsconfigPath, 'package TypeScript config');
    const compilerOptions = packageTsconfig.compilerOptions ?? {};
    const paths = { ...(compilerOptions.paths ?? {}) };

    for (const alias of externalSourceEntries) {
        paths[alias.specifier] = [toPosixPath(relative(packageRoot, alias.declarationEntry))];
    }

    const declarationTsconfigPath = resolve(tempTypesDir, 'tsconfig.dts.json');
    const declarationTsconfig = {
        extends: toRelativeConfigPath(relative(tempTypesDir, packageTsconfigPath)),
        compilerOptions: {
            baseUrl: toRelativeConfigPath(relative(tempTypesDir, packageRoot)),
            paths,
        },
        include: getInheritedConfigPaths(packageTsconfig.include, ['src']),
        exclude: getInheritedConfigPaths(packageTsconfig.exclude, ['dist']),
    };

    await writeFile(declarationTsconfigPath, `${JSON.stringify(declarationTsconfig, null, 2)}\n`);

    return declarationTsconfigPath;
}

// rollup-plugin-dts warns on some @qunhe/egs barrel cycles.
// Point the generated entry at defining modules before Rollup sees it.
async function rewriteCircularEgsDeclarationImports() {
    const declarationEntry = resolve(tempTypesDir, 'index.d.ts');
    const directEgsModules = new Map([
        ['Viewer', { module: '@qunhe/egs/src/Viewer', exportKind: 'type' }],
        ['Viewport', { module: '@qunhe/egs/src/Viewport', exportKind: 'type' }],
        ['ToneMapping', { module: '@qunhe/egs/src/elements/materials/quad/ToneMappingMaterial', exportKind: 'value' }],
        ['Vector3', { module: '@qunhe/egs/src/math/Vector3', exportKind: 'value' }],
        ['Vector4', { module: '@qunhe/egs/src/math/Vector4', exportKind: 'value' }],
    ]);
    const source = await readFile(declarationEntry, 'utf8');
    const rewritten = source
        .replace(/^\s*export\s+\{([^}]+)\}\s+from\s+["']@qunhe\/egs["'];$/gm, (_match, specifierText) => {
            const keptSpecifiers = [];
            const directExports = [];

            for (const specifier of splitNamedSpecifiers(specifierText)) {
                const name = getNamedSpecifierName(specifier);
                const directModule = directEgsModules.get(name);

                if (directModule) {
                    const exportKind = directModule.exportKind === 'type' ? 'type ' : '';
                    directExports.push(
                        `export { ${exportKind}${removeTypeModifier(specifier)} } from '${directModule.module}';`,
                    );
                } else {
                    keptSpecifiers.push(specifier);
                }
            }

            const exportLines = [];

            if (keptSpecifiers.length > 0) {
                exportLines.push(`export { ${keptSpecifiers.join(', ')} } from '@qunhe/egs';`);
            }

            exportLines.push(...directExports);

            return exportLines.join('\n');
        })
        .replace(/^\s*import\s+\{([^}]+)\}\s+from\s+["']@qunhe\/egs["'];$/gm, (_match, specifierText) => {
            const keptSpecifiers = [];
            const directImports = [];

            for (const specifier of splitNamedSpecifiers(specifierText)) {
                const name = getNamedSpecifierName(specifier);
                const directModule = directEgsModules.get(name);

                if (directModule) {
                    directImports.push(
                        `import type { ${removeTypeModifier(specifier)} } from '${directModule.module}';`,
                    );
                } else {
                    keptSpecifiers.push(specifier);
                }
            }

            const importLines = [];

            if (keptSpecifiers.length > 0) {
                importLines.push(`import { ${keptSpecifiers.join(', ')} } from '@qunhe/egs';`);
            }

            importLines.push(...directImports);

            return importLines.join('\n');
        });

    if (rewritten !== source) {
        await writeFile(declarationEntry, rewritten);
    }
}

async function stripPrivateTypingsImports() {
    const source = await readFile(declarationOutput, 'utf8');
    const rewritten = source.replace(/^\s*import\s+type\s+\{\s*\}\s+from\s+["']@qunhe\/egs-typings["'];?\r?\n?/gm, '');

    if (rewritten !== source) {
        await writeFile(declarationOutput, rewritten);
    }
}

function externalSourcePlugin() {
    return {
        name: 'aholo-external-source',
        setup(buildContext) {
            for (const alias of externalSourceEntries) {
                const escapedName = escapeRegExp(alias.specifier);

                buildContext.onResolve({ filter: new RegExp(`^${escapedName}$`) }, () => ({
                    path: alias.sourceEntry,
                }));
                buildContext.onResolve({ filter: new RegExp(`^${escapedName}/(.+)$`) }, args => {
                    const subpath = args.path.slice(alias.specifier.length + 1);

                    return {
                        path: resolveVendorRuntimePath(alias.sourceDir, subpath),
                    };
                });
            }
        },
    };
}

function vendorAliasPlugin() {
    return {
        name: 'aholo-vendor-alias',
        setup(buildContext) {
            for (const vendorPackage of vendorPackages) {
                const escapedName = escapeRegExp(vendorPackage.name);

                buildContext.onResolve({ filter: new RegExp(`^${escapedName}$`) }, () => ({
                    path: vendorPackage.entry,
                }));
                buildContext.onResolve({ filter: new RegExp(`^${escapedName}/(.+)$`) }, args => {
                    const subpath = args.path.slice(vendorPackage.name.length + 1);
                    const resolvedPath = resolveVendorRuntimePath(vendorPackage.root, subpath);

                    return {
                        path: resolvedPath,
                    };
                });
            }
        },
    };
}

function getExternalSourceEntries() {
    const packageTsconfig = readJsonFile(resolve(packageRoot, 'tsconfig.json'), 'package TypeScript config');
    const baseUrl = resolve(packageRoot, packageTsconfig.compilerOptions?.baseUrl ?? '.');
    const configuredPaths = packageTsconfig.compilerOptions?.paths;

    if (!configuredPaths || typeof configuredPaths !== 'object' || Array.isArray(configuredPaths)) {
        return [];
    }

    return Object.entries(configuredPaths)
        .map(([specifier, sourcePaths]) => {
            if (specifier.includes('*') || !Array.isArray(sourcePaths) || sourcePaths.length === 0) {
                return null;
            }

            const [sourcePath] = sourcePaths;

            if (typeof sourcePath !== 'string' || sourcePath.includes('*') || sourcePath.endsWith('.d.ts')) {
                return null;
            }

            const sourceEntry = resolve(baseUrl, sourcePath);

            if (!['.ts', '.tsx'].includes(extname(sourceEntry)) || !existsSync(sourceEntry)) {
                return null;
            }

            if (isInsidePackage(sourceEntry)) {
                return null;
            }

            const aliasPackageRoot = resolveAliasPackageRoot(sourceEntry, specifier);
            const tsconfigPath = resolve(aliasPackageRoot, 'tsconfig.json');

            if (!existsSync(tsconfigPath)) {
                throw new Error(`External source ${specifier} is missing tsconfig.json in ${aliasPackageRoot}.`);
            }

            const aliasTsconfig = readJsonFile(tsconfigPath, `external source ${specifier} TypeScript config`);
            const sourceRoot = resolve(
                aliasPackageRoot,
                aliasTsconfig.compilerOptions?.rootDir ?? dirname(sourceEntry),
            );
            const typesDir = resolve(tempTypesDir, '.external', sanitizePathSegment(specifier));
            const declarationEntry = replaceExtension(resolve(typesDir, relative(sourceRoot, sourceEntry)), '.d.ts');

            return {
                specifier,
                sourceEntry,
                sourceDir: dirname(sourceEntry),
                packageRoot: aliasPackageRoot,
                tsconfigPath,
                typesDir,
                declarationEntry,
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function getEgsRuntimePackages() {
    return getPackageJsonPaths(egsPackagesRoot)
        .map(packageJsonPath => {
            const packageRootPath = dirname(packageJsonPath);
            const egsPackageJson = readJsonFile(packageJsonPath, 'EGS package metadata');
            const entry = resolve(packageRootPath, 'index.ts');

            if (!egsPackageJson.name || !existsSync(entry)) {
                return null;
            }

            return {
                name: egsPackageJson.name,
                root: packageRootPath,
                entry,
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name));
}

function getPackageJsonPaths(dir) {
    return listFiles(dir, { skipDirectories: ['build', 'dist', 'node_modules'] }).filter(
        filePath => basename(filePath) === 'package.json',
    );
}

function resolveVendorRuntimePath(packageRootPath, subpath) {
    const candidate = resolve(packageRootPath, subpath);
    const candidates = [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        resolve(candidate, 'index.ts'),
        resolve(candidate, 'index.tsx'),
    ];

    for (const filePath of candidates) {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
            return filePath;
        }
    }

    return candidate;
}

function resolveAliasPackageRoot(sourceEntry, specifier) {
    let currentDir = dirname(sourceEntry);

    while (true) {
        if (existsSync(resolve(currentDir, 'package.json'))) {
            return currentDir;
        }

        if (resolve(currentDir) === workspaceRoot) {
            break;
        }

        const parentDir = dirname(currentDir);

        if (parentDir === currentDir) {
            break;
        }

        currentDir = parentDir;
    }

    throw new Error(`Unable to find package root for external source ${specifier}: ${sourceEntry}`);
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
