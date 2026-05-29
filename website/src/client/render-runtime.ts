import * as RendererApi from '@manycore/aholo-viewer';
import * as TweakpaneApi from 'tweakpane';
import type { Camera3D, Scene3D, Viewer } from '@manycore/aholo-viewer';
import type { Pane } from 'tweakpane';
import type { Diagnostic } from 'typescript';
import { CameraControl } from './camera-control';
import {
    abortable as abortableWithMessage,
    countSceneObjects,
    createAbortError as createAbortErrorWithMessage,
    syncCameraAspect,
    throwIfAborted as throwIfAbortedWithMessage,
} from './rendering';

export interface RenderStats {
    drawCalls: number;
    objects: number;
}

export interface RenderSession {
    stats: RenderStats;
    dispose(): void;
    resize(): void;
}

export interface RenderSessionStatus {
    state: 'loading' | 'ready';
    label?: string;
}

export interface RenderSessionOptions {
    configPanel?: RenderSessionConfigPanelOptions;
    refreshRate?: number;
    onStats?: (stats: RenderStats) => void;
    onStatus?: (status: RenderSessionStatus) => void;
    beginFrame?: () => void;
    endFrame?: () => void;
    renderer?: RenderSessionRendererOptions;
    signal?: AbortSignal;
}

export interface RenderSessionConfigPanelOptions {
    container?: HTMLElement | null;
    title?: string;
}

export interface RenderSessionRendererOptions {
    antialiasing?: boolean;
    pixelRatio?: number;
}

export interface RuntimeRenderer {
    readonly viewer: Viewer;
    readonly scene: Scene3D;
    frame(callback: (state: { time: number; delta: number }) => boolean): void;
    render(): void;
    resize(): void;
}

export interface RuntimeLoadingController {
    show(label?: string): void;
    hide(): void;
}

interface RuntimeConfigPaneOptions {
    expanded?: boolean;
    title?: string;
}

export interface RuntimeConfigPanel {
    readonly available: boolean;
    readonly container: HTMLElement;
    createPane(options?: RuntimeConfigPaneOptions): Pane;
    clear(): void;
    hide(): void;
    show(): void;
}

interface RuntimeIndexedDBSetOptions {
    version?: number;
}

interface RuntimeIndexedDBGetOptions {
    version?: number;
}

export interface RuntimeIndexedDBStorage {
    readonly available: boolean;
    get<T>(key: string, options?: RuntimeIndexedDBGetOptions): Promise<T | undefined>;
    set<T>(key: string, value: T, options?: RuntimeIndexedDBSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
}

export interface RenderRuntime {
    renderer: RuntimeRenderer;
    control: CameraControl;
    loading: RuntimeLoadingController;
    configPanel: RuntimeConfigPanel;
    indexedDB: RuntimeIndexedDBStorage;
    signal: AbortSignal;
}

type TypeScriptModule = typeof import('typescript');
type RenderRuntimeCleanup = () => void;
type RenderRuntimeEntry = (
    runtime: RenderRuntime,
) => void | RenderRuntimeCleanup | Promise<void | RenderRuntimeCleanup>;
type FrameCallback = (state: { time: number; delta: number }) => boolean;
type RuntimeRendererApi = typeof RendererApi;
type RuntimeTweakpaneApi = typeof TweakpaneApi;
type RenderSessionOptionsInput = RenderSessionOptions | ((stats: RenderStats) => void);
type TweakpanePane = InstanceType<typeof TweakpaneApi.Pane>;
type VersionedCacheOptions = {
    version?: number;
};
type IndexedDBCacheRecord<T = unknown> = {
    key: string;
    value: T;
    version?: number;
};

interface RuntimeGlobal {
    __AHOLO_RENDER_RUNTIME_API__?: RuntimeRendererApi;
    __AHOLO_TWEAKPANE_RUNTIME_API__?: RuntimeTweakpaneApi;
}

const RENDER_RUNTIME_DB_NAME = 'aholo-render-runtime';
const RENDER_RUNTIME_CACHE_STORE_NAME = 'runtime-cache';
const RENDER_RUNTIME_ABORT_MESSAGE = 'Render runtime was aborted.';

let renderSessionId = 0;
const renderSurfaces = new WeakMap<HTMLCanvasElement, HTMLElement>();

export async function createRenderSession(
    target: HTMLElement,
    code: string,
    accent: string,
    optionsInput?: RenderSessionOptionsInput,
): Promise<RenderSession> {
    const options = normalizeRenderSessionOptions(optionsInput);
    const abortController = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, abortController);
    const signal = abortController.signal;
    const loading = createRuntimeLoadingController(options.onStatus);
    const configPanel = createRuntimeConfigPanel(options.configPanel);
    const indexedDB = createRuntimeIndexedDBStorage(signal);
    let renderer: RenderSessionRenderer | undefined;
    let cleanup: RenderRuntimeCleanup | undefined;

    try {
        loading.startInitial();

        const entry = await abortable(compileRenderRuntimeModule(code), signal);
        throwIfAborted(signal);
        const surface = prepareRenderSurface(target, accent);
        renderer = new RenderSessionRenderer(
            surface,
            options.onStats,
            options.beginFrame,
            options.endFrame,
            options.renderer,
        );
        renderer.start();
        throwIfAborted(signal);
        const result = await abortable(
            Promise.resolve(
                entry({
                    renderer,
                    control: renderer.control,
                    loading: loading.controller,
                    configPanel: configPanel.controller,
                    indexedDB,
                    signal,
                }),
            ),
            signal,
        );

        cleanup = typeof result === 'function' ? result : undefined;
        throwIfAborted(signal);
        loading.finishInitial();

        return {
            stats: renderer.stats,
            dispose() {
                loading.dispose();
                configPanel.dispose();
                abortController.abort();
                unlinkAbortSignal();
                try {
                    cleanup?.();
                } finally {
                    renderer?.dispose();
                }
            },
            resize() {
                renderer?.resize();
            },
        };
    } catch (error) {
        loading.dispose();
        configPanel.dispose();
        abortController.abort();
        unlinkAbortSignal();
        try {
            cleanup?.();
        } finally {
            renderer?.dispose();
        }
        throw error;
    }
}

function normalizeRenderSessionOptions(options: RenderSessionOptionsInput | undefined): RenderSessionOptions {
    if (typeof options === 'function') {
        return {
            onStats: options,
        };
    }

    return options ?? {};
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController) {
    if (!source) {
        return () => {};
    }

    if (source.aborted) {
        target.abort();
        return () => {};
    }

    const abort = () => {
        target.abort();
    };
    source.addEventListener('abort', abort, { once: true });

    return () => {
        source.removeEventListener('abort', abort);
    };
}

function createRuntimeIndexedDBStorage(signal: AbortSignal): RuntimeIndexedDBStorage {
    const available = 'indexedDB' in globalThis;

    return {
        available,
        async get<T>(key: string, options?: VersionedCacheOptions) {
            if (!available) {
                return undefined;
            }

            const record = await readIndexedDBRecord<T>(key, signal);

            if (!record || !versionsMatch(record.version, options?.version)) {
                return undefined;
            }

            return record.value;
        },
        async set<T>(key: string, value: T, options?: VersionedCacheOptions) {
            if (!available) {
                return;
            }

            await writeIndexedDBRecord(
                {
                    key,
                    version: options?.version ?? 0,
                    value,
                },
                signal,
            );
        },
        async delete(key: string) {
            if (!available) {
                return;
            }

            await deleteIndexedDBRecord(key, signal);
        },
        async clear() {
            if (!available) {
                return;
            }

            await clearIndexedDBStore(signal);
        },
    };
}

function createRuntimeLoadingController(onStatus: RenderSessionOptions['onStatus']) {
    let disposed = false;
    let manualLoading = false;

    function notify(state: RenderSessionStatus['state'], label?: string) {
        if (!disposed) {
            onStatus?.({ state, label });
        }
    }

    const controller: RuntimeLoadingController = {
        show(label?: string) {
            manualLoading = true;
            notify('loading', label);
        },
        hide() {
            manualLoading = false;
            notify('ready');
        },
    };

    return {
        controller,
        dispose() {
            disposed = true;
        },
        finishInitial() {
            if (!manualLoading) {
                notify('ready');
            }
        },
        startInitial() {
            notify('loading');
        },
    };
}

function createRuntimeConfigPanel(options: RenderSessionConfigPanelOptions | undefined) {
    const connectedContainer = options?.container ?? undefined;
    const container = connectedContainer ?? document.createElement('div');
    const defaultTitle = options?.title ?? container.dataset.configPanelTitle ?? 'Config';
    let pane: TweakpanePane | undefined;

    hide();

    function show() {
        container.hidden = false;
        container.dataset.state = 'active';
    }

    function hide() {
        container.hidden = true;
        delete container.dataset.state;
    }

    function clear() {
        pane?.dispose();
        pane = undefined;
        container.replaceChildren();
    }

    const controller: RuntimeConfigPanel = {
        available: connectedContainer !== undefined,
        get container() {
            show();
            return container;
        },
        createPane(paneOptions: { expanded?: boolean; title?: string } = {}) {
            clear();
            show();
            pane = new TweakpaneApi.Pane({
                container,
                expanded: paneOptions.expanded ?? getDefaultConfigPaneExpanded(),
                title: paneOptions.title ?? defaultTitle,
            });
            return pane;
        },
        clear() {
            clear();
        },
        hide() {
            hide();
        },
        show() {
            show();
        },
    };

    return {
        controller,
        dispose() {
            clear();
            hide();
        },
    };
}

function getDefaultConfigPaneExpanded() {
    return !window.matchMedia('(max-width: 900px)').matches;
}

function throwIfAborted(signal: AbortSignal) {
    throwIfAbortedWithMessage(signal, RENDER_RUNTIME_ABORT_MESSAGE);
}

function createAbortError() {
    return createAbortErrorWithMessage(RENDER_RUNTIME_ABORT_MESSAGE);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
    return abortableWithMessage(promise, signal, RENDER_RUNTIME_ABORT_MESSAGE);
}

function versionsMatch(recordVersion: number | string | undefined, requestedVersion: number | string | undefined) {
    return requestedVersion === undefined || recordVersion === requestedVersion;
}

async function readIndexedDBRecord<T>(key: string, signal: AbortSignal): Promise<IndexedDBCacheRecord<T> | undefined> {
    const database = await openRuntimeIndexedDB(signal);

    try {
        const transaction = database.transaction(RENDER_RUNTIME_CACHE_STORE_NAME, 'readonly');
        const done = waitForIndexedDBTransaction(transaction, signal);
        const request = transaction.objectStore(RENDER_RUNTIME_CACHE_STORE_NAME).get(key);
        const record = await indexedDBRequestToPromise<IndexedDBCacheRecord<T> | undefined>(request, signal);
        await done;

        return record;
    } finally {
        database.close();
    }
}

async function writeIndexedDBRecord<T>(record: IndexedDBCacheRecord<T>, signal: AbortSignal) {
    const database = await openRuntimeIndexedDB(signal);

    try {
        const transaction = database.transaction(RENDER_RUNTIME_CACHE_STORE_NAME, 'readwrite');
        const done = waitForIndexedDBTransaction(transaction, signal);
        transaction.objectStore(RENDER_RUNTIME_CACHE_STORE_NAME).put(record);
        await done;
    } finally {
        database.close();
    }
}

async function deleteIndexedDBRecord(key: string, signal: AbortSignal) {
    const database = await openRuntimeIndexedDB(signal);

    try {
        const transaction = database.transaction(RENDER_RUNTIME_CACHE_STORE_NAME, 'readwrite');
        const done = waitForIndexedDBTransaction(transaction, signal);
        transaction.objectStore(RENDER_RUNTIME_CACHE_STORE_NAME).delete(key);
        await done;
    } finally {
        database.close();
    }
}

async function clearIndexedDBStore(signal: AbortSignal) {
    const database = await openRuntimeIndexedDB(signal);

    try {
        const transaction = database.transaction(RENDER_RUNTIME_CACHE_STORE_NAME, 'readwrite');
        const done = waitForIndexedDBTransaction(transaction, signal);
        transaction.objectStore(RENDER_RUNTIME_CACHE_STORE_NAME).clear();
        await done;
    } finally {
        database.close();
    }
}

function openRuntimeIndexedDB(
    signal: AbortSignal,
    version?: number,
    schemaRepairAttempted = false,
): Promise<IDBDatabase> {
    if (signal.aborted) {
        return Promise.reject(createAbortError());
    }

    return new Promise((resolve, reject) => {
        const request =
            version === undefined
                ? indexedDB.open(RENDER_RUNTIME_DB_NAME)
                : indexedDB.open(RENDER_RUNTIME_DB_NAME, version);
        const rejectAbort = () => {
            reject(createAbortError());
        };

        signal.addEventListener('abort', rejectAbort, { once: true });

        request.onupgradeneeded = () => {
            const database = request.result;

            if (!database.objectStoreNames.contains(RENDER_RUNTIME_CACHE_STORE_NAME)) {
                database.createObjectStore(RENDER_RUNTIME_CACHE_STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => {
            signal.removeEventListener('abort', rejectAbort);
            const database = request.result;

            if (signal.aborted) {
                database.close();
                reject(createAbortError());
                return;
            }

            if (!database.objectStoreNames.contains(RENDER_RUNTIME_CACHE_STORE_NAME)) {
                if (schemaRepairAttempted) {
                    database.close();
                    reject(new Error(`IndexedDB store "${RENDER_RUNTIME_CACHE_STORE_NAME}" could not be created.`));
                    return;
                }

                const nextVersion = database.version + 1;
                database.close();
                openRuntimeIndexedDB(signal, nextVersion, true).then(resolve, reject);
                return;
            }

            resolve(database);
        };
        request.onerror = () => {
            signal.removeEventListener('abort', rejectAbort);
            reject(request.error ?? new Error('IndexedDB open failed.'));
        };
        request.onblocked = () => {
            signal.removeEventListener('abort', rejectAbort);
            reject(new Error('IndexedDB upgrade is blocked by another open tab.'));
        };
    });
}

function indexedDBRequestToPromise<T>(request: IDBRequest<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        const rejectAbort = () => {
            reject(createAbortError());
        };

        signal.addEventListener('abort', rejectAbort, { once: true });

        request.onsuccess = () => {
            signal.removeEventListener('abort', rejectAbort);
            resolve(request.result);
        };
        request.onerror = () => {
            signal.removeEventListener('abort', rejectAbort);
            reject(request.error ?? new Error('IndexedDB request failed.'));
        };
    });
}

function waitForIndexedDBTransaction(transaction: IDBTransaction, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            signal.removeEventListener('abort', rejectAbort);
        };
        const rejectAbort = () => {
            try {
                transaction.abort();
            } catch {
                // The transaction may have already completed.
            }

            reject(createAbortError());
        };

        signal.addEventListener('abort', rejectAbort, { once: true });

        transaction.oncomplete = () => {
            cleanup();
            resolve();
        };
        transaction.onerror = () => {
            cleanup();
            reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
        };
        transaction.onabort = () => {
            cleanup();
            reject(transaction.error ?? createAbortError());
        };
    });
}

async function compileRenderRuntimeModule(code: string): Promise<RenderRuntimeEntry> {
    const ts = await import('typescript');
    const output = transpileRenderRuntimeCode(ts, code);
    const module = await importModule(output);
    const entry = module.default;

    if (typeof entry !== 'function') {
        throw new Error('Playground code must export a default function.');
    }

    return entry as RenderRuntimeEntry;
}

function transpileRenderRuntimeCode(ts: TypeScriptModule, code: string) {
    const result = ts.transpileModule(code, {
        compilerOptions: {
            allowJs: true,
            esModuleInterop: true,
            module: ts.ModuleKind.ESNext,
            strict: true,
            target: ts.ScriptTarget.ES2020,
        },
        reportDiagnostics: true,
    });

    const diagnostic = result.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
    if (diagnostic) {
        throw new Error(formatDiagnostic(ts, diagnostic));
    }

    const outputText = replaceRuntimeImports(result.outputText);

    if (/^\s*import\s/m.test(outputText)) {
        throw new Error('Playground code can only import runtime objects from @manycore/aholo-viewer and tweakpane.');
    }

    return `${outputText}\n//# sourceURL=aholo-render-runtime.js`;
}

function replaceRuntimeImports(source: string) {
    return source
        .replace(
            /^\s*import\s+\{([\s\S]*?)\}\s+from\s+["']@manycore\/aholo-viewer["'];?\s*$/gm,
            (_match, specifiers: string) => {
                const bindings = specifiers
                    .split(',')
                    .map(specifier => specifier.trim())
                    .filter(Boolean)
                    .map(specifier => specifier.replace(/\s+as\s+/u, ': '))
                    .join(', ');

                return `const { ${bindings} } = globalThis.__AHOLO_RENDER_RUNTIME_API__;`;
            },
        )
        .replace(
            /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']@manycore\/aholo-viewer["'];?\s*$/gm,
            'const $1 = globalThis.__AHOLO_RENDER_RUNTIME_API__;',
        )
        .replace(/^\s*import\s+\{([\s\S]*?)\}\s+from\s+["']tweakpane["'];?\s*$/gm, (_match, specifiers: string) => {
            const bindings = specifiers
                .split(',')
                .map(specifier => specifier.trim())
                .filter(Boolean)
                .map(specifier => specifier.replace(/\s+as\s+/u, ': '))
                .join(', ');

            return `const { ${bindings} } = globalThis.__AHOLO_TWEAKPANE_RUNTIME_API__;`;
        })
        .replace(
            /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']tweakpane["'];?\s*$/gm,
            'const $1 = globalThis.__AHOLO_TWEAKPANE_RUNTIME_API__;',
        );
}

async function importModule(source: string) {
    const runtimeGlobal = globalThis as typeof globalThis & RuntimeGlobal;
    runtimeGlobal.__AHOLO_RENDER_RUNTIME_API__ = RendererApi;
    runtimeGlobal.__AHOLO_TWEAKPANE_RUNTIME_API__ = TweakpaneApi;

    const url = URL.createObjectURL(
        new Blob([source], {
            type: 'text/javascript',
        }),
    );

    try {
        return await import(/* @vite-ignore */ url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function formatDiagnostic(ts: TypeScriptModule, diagnostic: Diagnostic) {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

class RenderSessionRenderer implements RuntimeRenderer {
    readonly #viewer: Viewer;
    readonly #scene: Scene3D;
    readonly #camera: Camera3D;
    readonly #control: CameraControl;
    readonly #onStats: ((stats: RenderStats) => void) | undefined;
    readonly #frameCallbacks: FrameCallback[] = [];
    readonly #beginFrame: (() => void) | undefined;
    readonly #endFrame: (() => void) | undefined;
    #rafRequestId: number | undefined;
    #frameId = 0;
    #resizeTimer: number | undefined;
    #lastFrameTime = 0;
    #renderRequested = true;
    #disposed = false;
    #stats: RenderStats = {
        drawCalls: 0,
        objects: 0,
    };

    constructor(
        surface: HTMLElement,
        onStats?: (stats: RenderStats) => void,
        beginFrame?: () => void,
        endFrame?: () => void,
        options: RenderSessionRendererOptions = {},
    ) {
        this.#onStats = onStats;
        this.#beginFrame = beginFrame;
        this.#endFrame = endFrame;

        removeEngineCanvases(surface);
        this.#viewer = RendererApi.createViewer(`aholo-render-${++renderSessionId}`, surface, {
            antialiasing: options.antialiasing ?? false,
        });
        RendererApi.setViewerConfig(this.#viewer, {
            pixelRatio: (options.pixelRatio ?? 1) / window.devicePixelRatio,
            pipeline: {
                Background: {
                    background: {
                        active: RendererApi.BackgroundMode.BasicBackground,
                        basic: {
                            color: new RendererApi.Color(0, 0, 0),
                        },
                    },
                    ground: {
                        enabled: false,
                    },
                },
                Splatting: {
                    preBlurAmount: 0.3,
                    blurAmount: 0,
                    focalAdjustment: 2,
                },
                TAA: {
                    enabled: false,
                },
            },
        });
        this.#viewer.requestRenderHandler = this.requestRender;
        this.#scene = new RendererApi.Scene3D();
        this.#camera = new RendererApi.PerspectiveCamera(60, 1, 0.1, 2000);
        this.#viewer.setScene(this.#scene);
        this.#viewer.setCamera(this.#camera);
        this.#control = new CameraControl(this.#camera, surface, {
            enabled: false,
        });

        this.#resizeTimer = window.setTimeout(() => {
            this.resize();
        }, 0);
    }

    get control() {
        return this.#control;
    }

    get viewer() {
        return this.#viewer;
    }

    get scene() {
        return this.#scene;
    }

    get stats() {
        return this.#stats;
    }

    frame(callback: FrameCallback): void {
        this.#frameCallbacks.push(callback);
        this.requestRender();
    }

    render(): void {
        if (this.#disposed) {
            return;
        }

        syncCameraAspect(this.#viewer.getCamera(), this.#viewer);
        this.#viewer.getScene().notifySceneChange();
        this.requestRender();
    }

    requestRender = () => {
        this.#renderRequested = true;
    };

    resize(): void {
        if (this.#disposed) {
            return;
        }

        this.#viewer.resize();

        syncCameraAspect(this.#viewer.getCamera(), this.#viewer);
        this.requestRender();
    }

    start() {
        if (this.#rafRequestId !== undefined) {
            return;
        }

        this.resize();
        this.#rafRequestId = window.requestAnimationFrame(this.#tick);
    }

    dispose() {
        if (this.#disposed) {
            return;
        }

        this.#disposed = true;

        if (this.#resizeTimer !== undefined) {
            window.clearTimeout(this.#resizeTimer);
            this.#resizeTimer = undefined;
        }

        if (this.#rafRequestId !== undefined) {
            window.cancelAnimationFrame(this.#rafRequestId);
            this.#rafRequestId = undefined;
        }

        this.#viewer.requestRenderHandler = undefined;
        this.#control.dispose();
        this.#viewer.destroy();
    }

    #tick = (time: number) => {
        if (this.#disposed) {
            return;
        }
        this.#beginFrame?.();
        const delta = this.#lastFrameTime > 0 ? Math.min((time - this.#lastFrameTime) / 1000, 0.1) : 0;
        this.#lastFrameTime = time;
        this.#frameId++;

        let shouldRender = this.#renderRequested;
        for (const callback of this.#frameCallbacks) {
            shouldRender = callback({ time, delta }) || shouldRender;
        }
        if (shouldRender) {
            this.#renderRequested = false;
            this.#viewer.render();
            this.#updateStats();
        }
        this.#endFrame?.();
        this.#rafRequestId = window.requestAnimationFrame(this.#tick);
    };

    #updateStats() {
        const renderStats = this.#viewer.getRenderStatistics();
        this.#stats = {
            drawCalls: Number(renderStats.calls ?? 0),
            objects: countSceneObjects(this.#viewer.getScene()),
        };
        this.#onStats?.(this.#stats);
    }
}

function prepareRenderSurface(target: HTMLElement, accent: string) {
    if (!(target instanceof HTMLCanvasElement)) {
        styleRenderSurface(target, accent);
        return target;
    }

    let surface = renderSurfaces.get(target);

    if (!surface) {
        surface = document.createElement('div');
        renderSurfaces.set(target, surface);
        target.before(surface);
    } else if (!surface.isConnected) {
        target.before(surface);
    }

    for (const className of target.classList) {
        surface.classList.add(className);
    }

    target.hidden = true;
    target.style.display = 'none';
    target.setAttribute('aria-hidden', 'true');

    styleRenderSurface(surface, accent, target);
    return surface;
}

function styleRenderSurface(surface: HTMLElement, accent: string, source?: HTMLElement) {
    surface.classList.add('renderer-runtime-surface');
    surface.dataset.rendererRuntimeSurface = 'true';
    surface.style.setProperty('--runtime-accent', accent);
    surface.style.display = 'block';
    surface.style.width = '100%';
    surface.style.height = '100%';
    surface.style.minHeight = '0';
    surface.style.overflow = 'hidden';

    if (!source) {
        surface.style.position ||= 'relative';
        return;
    }

    const sourceStyle = window.getComputedStyle(source);

    if (sourceStyle.position === 'absolute' || sourceStyle.position === 'fixed') {
        surface.style.position = sourceStyle.position;
        surface.style.inset = '0';
        surface.style.zIndex = sourceStyle.zIndex;
    } else {
        surface.style.position = 'relative';
    }
}

function removeEngineCanvases(surface: HTMLElement) {
    for (const child of Array.from(surface.children)) {
        if (child instanceof HTMLCanvasElement && child.dataset.engine) {
            child.remove();
        }
    }
}
