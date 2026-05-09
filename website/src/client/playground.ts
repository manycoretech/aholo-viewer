import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { Pane } from 'tweakpane';
import * as TweakpaneEssentialsPlugin from '@tweakpane/plugin-essentials';
import type { RenderSession } from './render-runtime';
import { createRenderSession } from './render-runtime';
import { mountSplitPane } from './split-pane';
import { mountWorkspaceFullscreenMode } from './workspace-fullscreen';

const CODE_QUERY_PARAM = 'code';
const PRESET_QUERY_PARAM = 'example';
const URL_SYNC_DELAY = 250;
const DEFAULT_EDITOR_WIDTH_PERCENT = 48;
const EDITOR_COLLAPSE_THRESHOLD_PX = 260;
const EDITOR_MIN_WIDTH_PX = 360;
const EDITOR_SIDE_MIN_RATIO = 0.42;
const INSPECTOR_REFRESH_INTERVAL_MS = 100;
const DEFAULT_REFRESH_RATE = 60;
const FPS_GRAPH_HEADROOM = 1.5;

type MonacoModule = typeof import('monaco-editor/esm/vs/editor/editor.api.js');
type MonacoTextModel = ReturnType<MonacoModule['editor']['createModel']>;
interface RenderStats {
    drawCalls: number;
    objects: number;
}

interface PlaygroundRendererOptions {
    antialiasing?: boolean;
    pixelRatio?: number;
}

interface PlaygroundPreset {
    slug: string;
    title: string;
    tags: string[];
    code: string;
    accent: string;
    renderer: PlaygroundRendererOptions;
}

interface PlaygroundConfig {
    presets: PlaygroundPreset[];
    labels: {
        ready: string;
        error: string;
    };
    common: {
        run: string;
        preset: string;
    };
    typeDefinitions: Array<{
        path: string;
        content: string;
    }>;
}

interface TypeScriptContribution {
    ModuleKind: {
        ESNext: number;
    };
    ModuleResolutionKind: {
        NodeJs: number;
    };
    ScriptTarget: {
        ES2020: number;
    };
    typescriptDefaults: {
        addExtraLib(content: string, filePath?: string): unknown;
        setCompilerOptions(options: Record<string, unknown>): void;
        setDiagnosticsOptions(options: Record<string, unknown>): void;
    };
}

interface MonacoRuntime {
    monaco: MonacoModule;
    typescript: TypeScriptContribution;
}

interface EditorController {
    getValue(): string;
    setPreset(preset: PlaygroundPreset, code?: string): void;
    onChange(callback: (code: string) => void): void;
    layout(): void;
}

const detectRefreshRate = (function () {
    function refreshRate() {
        let frameCount = 0;
        let startTime = 0;
        return new Promise<number>(resolve => {
            function estimateRefreshRate(currentTime: number) {
                frameCount++;
                const elapsedTime = currentTime - startTime;
                if (elapsedTime >= 1000) {
                    resolve(normalizeRefreshRate(Math.round((frameCount * 1000) / elapsedTime)));
                    return;
                }
                requestAnimationFrame(estimateRefreshRate);
            }

            requestAnimationFrame(t => {
                startTime = t;
                frameCount = -1;
                estimateRefreshRate(t);
            });
        });
    }
    let cached: number | undefined = undefined;

    return async function () {
        if (cached == null) {
            cached = await refreshRate();
        }
        return cached;
    };
})();

let monacoPromise: Promise<MonacoRuntime> | undefined;

export async function mountPlayground(root: HTMLElement, config: PlaygroundConfig) {
    const editorHost = query<HTMLElement>(root, '[data-editor-host]');
    const loading = query<HTMLElement>(root, '[data-editor-loading]');
    const canvas = query<HTMLCanvasElement>(root, '[data-render-canvas]');
    const presetMenu = query<HTMLElement>(root, '[data-preset-menu]');
    const presetTrigger = query<HTMLButtonElement>(root, '[data-preset-trigger]');
    const currentPresetLabel = query<HTMLElement>(root, '[data-current-preset]');
    const presetList = query<HTMLElement>(root, '[data-preset-list]');
    const status = query<HTMLElement>(root, '[data-status]');
    const runButton = query<HTMLButtonElement>(root, '[data-run]');
    const workspace = query<HTMLElement>(root, '[data-workspace]');
    const splitter = query<HTMLElement>(root, '[data-workspace-splitter]');
    const inspector = query<HTMLElement>(root, '[data-inspector]');
    const configPanel = root.querySelector<HTMLElement>('[data-config-panel]');
    const previewStatus = root.querySelector<HTMLElement>('[data-preview-status]');

    const initialParams = new URLSearchParams(window.location.search);
    const requestedPreset = initialParams.get(PRESET_QUERY_PARAM);
    const initialCode = readCodeFromUrl(initialParams);
    let currentPreset = config.presets.find(preset => preset.slug === requestedPreset) ?? config.presets[0];
    let isApplyingEditorValue = false;
    let urlSyncTimer: number | undefined;
    let runId = 0;
    let activeSession: RenderSession | undefined;
    let runAbortController: AbortController | undefined;
    const presetButtons = new Map<string, HTMLButtonElement>();
    const inspectorPane = await setupInspectorPane(inspector);

    setStatus('loading', 'Loading editor');

    for (const preset of config.presets) {
        const button = createPresetButton(preset);
        button.addEventListener('click', () => {
            applyPreset(preset, { syncUrl: true });
            setPresetMenuOpen(false);
            presetTrigger.focus();
        });
        presetButtons.set(preset.slug, button);
        presetList.append(button);
    }

    const monacoRuntime = await loadMonaco();
    configureTypeScript(monacoRuntime.typescript, config);
    const editor = createCodeEditor(monacoRuntime.monaco, editorHost, config);
    const fullscreenMode = mountWorkspaceFullscreenMode({
        onChange() {
            handleViewportChange();
        },
    });
    let disposed = false;
    loading.remove();

    function applyPreset(preset: PlaygroundPreset, options: { code?: string; syncUrl?: boolean } = {}) {
        currentPreset = preset;
        updatePresetMenu(preset);
        applyEditorValue(() => editor.setPreset(preset, options.code));

        if (options.syncUrl) {
            if (urlSyncTimer !== undefined) {
                window.clearTimeout(urlSyncTimer);
                urlSyncTimer = undefined;
            }

            syncPresetUrl(preset);
        }

        run();
    }

    function applyEditorValue(callback: () => void) {
        isApplyingEditorValue = true;
        callback();
        window.setTimeout(() => {
            isApplyingEditorValue = false;
        }, 0);
    }

    async function run() {
        const nextRunId = runId + 1;
        runId = nextRunId;
        runAbortController?.abort();
        const abortController = new AbortController();
        runAbortController = abortController;
        activeSession?.dispose();
        activeSession = undefined;
        inspectorPane.setError('');
        setStatus('loading', config.common.run);
        setPreviewStatus('loading', previewStatus?.dataset.loadingLabel ?? config.common.run);

        try {
            const session = await createRenderSession(canvas, editor.getValue(), currentPreset.accent, {
                configPanel: configPanel
                    ? {
                          container: configPanel,
                          title: configPanel.dataset.configPanelTitle ?? 'Config',
                      }
                    : undefined,
                signal: abortController.signal,
                renderer: currentPreset.renderer,
                onStats(stats) {
                    if (nextRunId === runId) {
                        updateStats(stats);
                    }
                },
                beginFrame() {
                    inspectorPane.beginFrame();
                },
                endFrame() {
                    inspectorPane.endFrame();
                },
                onStatus(nextStatus) {
                    if (nextRunId !== runId) {
                        return;
                    }

                    const label =
                        nextStatus.label ?? (nextStatus.state === 'loading' ? config.common.run : config.labels.ready);
                    setStatus(nextStatus.state, label);
                    setPreviewStatus(
                        nextStatus.state,
                        nextStatus.state === 'loading'
                            ? (nextStatus.label ?? previewStatus?.dataset.loadingLabel)
                            : undefined,
                    );
                },
            });

            if (nextRunId !== runId) {
                session.dispose();
                return;
            }

            activeSession = session;
            if (runAbortController === abortController) {
                runAbortController = undefined;
            }
            updateStats(session.stats);
        } catch (caught) {
            if (nextRunId !== runId) {
                return;
            }

            if (runAbortController === abortController) {
                runAbortController = undefined;
            }
            const message = caught instanceof Error ? caught.message : String(caught);
            inspectorPane.setError(message);
            inspectorPane.expand();
            setPreviewStatus('ready');
            setStatus('error', config.labels.error);
        }
    }

    presetTrigger.addEventListener('click', () => {
        setPresetMenuOpen(presetList.hidden);
    });
    presetTrigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPresetMenuOpen(true);
        }
    });
    presetList.addEventListener('keydown', handlePresetListKeydown);
    document.addEventListener('pointerdown', event => {
        if (event.target instanceof Node && !presetMenu.contains(event.target)) {
            setPresetMenuOpen(false);
        }
    });

    editor.onChange(code => {
        if (isApplyingEditorValue) {
            return;
        }

        scheduleCodeUrlSync(code, currentPreset);
    });

    runButton.addEventListener('click', run);

    const splitPane = mountSplitPane({
        container: workspace,
        splitter,
        collapsedDatasetKey: 'paneCollapsed',
        cssProperty: '--editor-width',
        defaultValue: DEFAULT_EDITOR_WIDTH_PERCENT,
        valueUnit: '%',
        keyboardStep: 4,
        clampValue(value, rect) {
            if (rect.width <= 0) {
                return value;
            }

            const requestedWidth = (value / 100) * rect.width;
            const minimum = Math.min(EDITOR_MIN_WIDTH_PX, rect.width * EDITOR_SIDE_MIN_RATIO);
            const maximum = rect.width - minimum;
            const width = Math.min(Math.max(requestedWidth, minimum), maximum);

            return (width / rect.width) * 100;
        },
        shouldCollapse(value, rect) {
            return (value / 100) * rect.width <= Math.min(EDITOR_COLLAPSE_THRESHOLD_PX, rect.width * 0.28);
        },
        pointerToValue(event, rect) {
            return rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * 100 : DEFAULT_EDITOR_WIDTH_PERCENT;
        },
        onChange() {
            editor.layout();
            resizePreview();
        },
    });
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('beforeunload', dispose, { once: true });
    document.addEventListener('astro:before-swap', dispose, { once: true });

    applyPreset(currentPreset, { code: initialCode });

    function handleViewportChange() {
        setPresetMenuOpen(false);
        editor.layout();
        resizePreview();
    }

    function dispose() {
        if (disposed) {
            return;
        }

        disposed = true;
        runAbortController?.abort();
        activeSession?.dispose();
        inspectorPane.dispose();
        splitPane.dispose();
        fullscreenMode.dispose();
        window.removeEventListener('resize', handleViewportChange);
        window.removeEventListener('beforeunload', dispose);
        document.removeEventListener('astro:before-swap', dispose);
    }

    function scheduleCodeUrlSync(code: string, preset: PlaygroundPreset) {
        if (urlSyncTimer !== undefined) {
            window.clearTimeout(urlSyncTimer);
        }

        urlSyncTimer = window.setTimeout(() => {
            syncCodeUrl(code, preset);
            urlSyncTimer = undefined;
        }, URL_SYNC_DELAY);
    }

    function setStatus(state: 'loading' | 'ready' | 'error', label: string) {
        status.dataset.state = state;
        status.setAttribute('aria-label', `${config.common.run}: ${label}`);
        status.title = label;
    }

    function setPreviewStatus(state: 'loading' | 'ready', label?: string) {
        if (!previewStatus) {
            return;
        }

        if (state === 'ready') {
            previewStatus.hidden = true;
            previewStatus.textContent = '';
            return;
        }

        previewStatus.hidden = false;
        previewStatus.textContent = label ?? previewStatus.dataset.loadingLabel ?? config.common.run;
    }

    function updateStats(stats: RenderStats) {
        inspectorPane.updateStats(stats);
    }

    function resizePreview() {
        activeSession?.resize();
    }

    function createPresetButton(preset: PlaygroundPreset) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'preset-option';
        button.dataset.presetOption = preset.slug;
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', 'false');
        button.style.setProperty('--preset-accent', preset.accent);

        const marker = document.createElement('span');
        marker.className = 'preset-option-marker';
        marker.setAttribute('aria-hidden', 'true');

        const content = document.createElement('span');
        content.className = 'preset-option-content';

        const title = document.createElement('strong');
        title.textContent = preset.title;

        const tags = document.createElement('span');
        tags.className = 'preset-option-tags';
        tags.textContent = preset.tags.join(' / ');

        content.append(title, tags);
        button.append(marker, content);

        return button;
    }

    function updatePresetMenu(preset: PlaygroundPreset) {
        currentPresetLabel.textContent = preset.title;
        currentPresetLabel.style.setProperty('--preset-accent', preset.accent);

        for (const [slug, button] of presetButtons) {
            const isActive = slug === preset.slug;
            button.setAttribute('aria-checked', String(isActive));
            if (isActive) {
                button.dataset.active = 'true';
            } else {
                delete button.dataset.active;
            }
        }
    }

    function setPresetMenuOpen(open: boolean) {
        presetList.hidden = !open;
        presetTrigger.setAttribute('aria-expanded', String(open));

        if (open) {
            const activeButton =
                presetButtons.get(currentPreset.slug) ?? presetList.querySelector<HTMLButtonElement>('button');
            activeButton?.focus({ preventScroll: true });
        }
    }

    function handlePresetListKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            setPresetMenuOpen(false);
            presetTrigger.focus();
            return;
        }

        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
            return;
        }

        event.preventDefault();
        const buttons = Array.from(presetButtons.values());
        const currentIndex = buttons.findIndex(button => button === document.activeElement);

        if (event.key === 'Home') {
            buttons[0]?.focus();
            return;
        }

        if (event.key === 'End') {
            buttons[buttons.length - 1]?.focus();
            return;
        }

        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
    }
}

async function loadMonaco() {
    if (!monacoPromise) {
        monacoPromise = (async () => {
            const [{ default: EditorWorker }, { default: TypeScriptWorker }] = await Promise.all([
                import('monaco-editor/esm/vs/editor/editor.worker.js?worker&inline'),
                import('monaco-editor/esm/vs/language/typescript/ts.worker.js?worker&inline'),
            ]);

            (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
                getWorker(_workerId: string, label: string) {
                    if (label === 'typescript' || label === 'javascript') {
                        return new TypeScriptWorker();
                    }
                    return new EditorWorker();
                },
            };

            const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js');
            await import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js');
            const typescript =
                (await import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js')) as unknown as TypeScriptContribution;

            return {
                monaco,
                typescript,
            };
        })();
    }

    return monacoPromise;
}

function configureTypeScript(typescript: TypeScriptContribution, config: PlaygroundConfig) {
    const defaults = typescript.typescriptDefaults;

    defaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: false,
    });
    defaults.setCompilerOptions({
        allowNonTsExtensions: true,
        module: typescript.ModuleKind.ESNext,
        moduleResolution: typescript.ModuleResolutionKind.NodeJs,
        noEmit: true,
        strict: true,
        target: typescript.ScriptTarget.ES2020,
        lib: ['es2020', 'dom'],
    });
    for (const definition of config.typeDefinitions) {
        defaults.addExtraLib(definition.content, definition.path);
    }
}

function createCodeEditor(monaco: MonacoModule, host: HTMLElement, config: PlaygroundConfig): EditorController {
    const models = new Map<string, MonacoTextModel>();
    const editor = monaco.editor.create(host, {
        automaticLayout: false,
        contextmenu: false,
        fixedOverflowWidgets: true,
        fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
        fontSize: 13,
        lineNumbers: 'on',
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        padding: { top: 14, bottom: 92 },
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        scrollbar: {
            horizontalScrollbarSize: 10,
            verticalScrollbarSize: 10,
        },
        tabSize: 2,
        theme: document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs',
        wordWrap: 'off',
    });

    for (const preset of config.presets) {
        models.set(preset.slug, createModel(monaco, preset));
    }

    const themeObserver = new MutationObserver(() => {
        monaco.editor.setTheme(document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs');
    });
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });

    return {
        getValue() {
            return editor.getValue();
        },
        setPreset(preset, code = preset.code) {
            const model = models.get(preset.slug) ?? createModel(monaco, preset);
            model.setValue(code);
            models.set(preset.slug, model);
            editor.setModel(model);
            editor.focus();
            editor.layout();
        },
        onChange(callback) {
            editor.onDidChangeModelContent(() => callback(editor.getValue()));
        },
        layout() {
            editor.layout();
        },
    };
}

function createModel(monaco: MonacoModule, preset: PlaygroundPreset) {
    const uri = monaco.Uri.parse(`file:///src/content/examples/${preset.slug}.ts`);
    const existing = monaco.editor.getModel(uri);

    if (existing) {
        existing.setValue(preset.code);
        return existing;
    }

    return monaco.editor.createModel(preset.code, 'typescript', uri);
}

async function setupInspectorPane(container: HTMLElement) {
    const params = {
        fps: DEFAULT_REFRESH_RATE,
        drawCalls: 0,
        objects: 0,
        error: '',
    };
    const pane = new Pane({
        container,
        expanded: true,
        title: container.dataset.inspectorTitle ?? 'Inspector',
    });

    pane.registerPlugin(TweakpaneEssentialsPlugin);

    let pendingStats: RenderStats | undefined;
    let refreshTimer: number | undefined;
    let lastRefreshTime = 0;

    const fpsGraph = pane.addBlade({
        view: 'fpsgraph',
        label: 'FPS',
        max: (await detectRefreshRate()) * FPS_GRAPH_HEADROOM,
        rows: 2,
    });
    pane.addBinding(params, 'drawCalls', {
        interval: INSPECTOR_REFRESH_INTERVAL_MS,
        label: container.dataset.drawCallsLabel ?? 'Draw calls',
        format: v => v.toString(),
        readonly: true,
    });
    pane.addBinding(params, 'objects', {
        interval: INSPECTOR_REFRESH_INTERVAL_MS,
        label: container.dataset.objectsLabel ?? 'Objects',
        format: v => v.toString(),
        readonly: true,
    });
    const errorBinding = pane.addBinding(params, 'error', {
        label: container.dataset.errorLabel ?? 'Error',
        multiline: true,
        readonly: true,
        rows: 3,
    });
    errorBinding.hidden = true;

    function scheduleRefresh() {
        if (refreshTimer !== undefined) {
            return;
        }

        const now = performance.now();
        const delay = Math.max(0, INSPECTOR_REFRESH_INTERVAL_MS - (now - lastRefreshTime));
        refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            lastRefreshTime = performance.now();
            applyPendingStats();
            pane.refresh();
        }, delay);
    }

    function applyPendingStats() {
        if (!pendingStats) {
            return;
        }

        const stats = pendingStats;
        pendingStats = undefined;

        params.drawCalls = stats.drawCalls;
        params.objects = stats.objects;
    }

    return {
        dispose() {
            if (refreshTimer !== undefined) {
                window.clearTimeout(refreshTimer);
                refreshTimer = undefined;
            }

            pane.dispose();
        },
        expand() {
            pane.expanded = true;
        },
        setError(message: string) {
            params.error = message;
            errorBinding.hidden = message.length === 0;
            scheduleRefresh();
        },
        beginFrame() {
            (fpsGraph as any).begin();
        },
        endFrame() {
            (fpsGraph as any).end();
        },
        updateStats(stats: RenderStats) {
            pendingStats = stats;
            scheduleRefresh();
        },
    };
}

function normalizeRefreshRate(value: number) {
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_REFRESH_RATE;
}

function normalizeFps(value: number, fallback: number) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readCodeFromUrl(params: URLSearchParams) {
    const encodedCode = params.get(CODE_QUERY_PARAM);

    if (!encodedCode) {
        return undefined;
    }

    try {
        return decompressFromEncodedURIComponent(encodedCode) ?? undefined;
    } catch {
        return undefined;
    }
}

function syncPresetUrl(preset: PlaygroundPreset) {
    const url = new URL(window.location.href);
    url.searchParams.set(PRESET_QUERY_PARAM, preset.slug);
    url.searchParams.delete(CODE_QUERY_PARAM);
    window.history.replaceState({}, '', url);
}

function syncCodeUrl(code: string, preset: PlaygroundPreset) {
    const url = new URL(window.location.href);
    url.searchParams.set(PRESET_QUERY_PARAM, preset.slug);
    url.searchParams.set(CODE_QUERY_PARAM, compressToEncodedURIComponent(code));
    window.history.replaceState({}, '', url);
}

function query<T extends Element>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);

    if (!element) {
        throw new Error(`Missing playground element: ${selector}`);
    }

    return element;
}
