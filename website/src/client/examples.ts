import { createRenderSession } from './render-runtime';
import { mountSplitPane } from './split-pane';
import { WORKSPACE_FULLSCREEN_CHANGE_EVENT, mountWorkspaceFullscreenMode } from './workspace-fullscreen';

interface PreviewEmbedConfig {
    accent: string;
    configLabel: string;
    code: string;
    errorLabel: string;
    loadingLabel: string;
    renderer: {
        antialiasing: boolean;
        pixelRatio?: number;
    };
}

export function mountAllPreviewEmbeds(root: ParentNode = document) {
    for (const previewRoot of root.querySelectorAll<HTMLElement>('[data-example-preview]')) {
        mountPreviewEmbed(previewRoot);
    }
}

function mountPreviewEmbed(root: HTMLElement) {
    if (root.dataset.mounted === 'true') {
        return;
    }

    root.dataset.mounted = 'true';

    const canvas = root.querySelector<HTMLCanvasElement>('[data-example-preview-canvas]');
    const configPanel = root.querySelector<HTMLElement>('[data-example-config-panel]');
    const configElement = root.querySelector<HTMLScriptElement>('[data-example-preview-config]');
    const status = root.querySelector<HTMLElement>('[data-example-preview-status]');

    if (!canvas || !configElement?.textContent) {
        return;
    }

    const previewCanvas = canvas;
    const config = JSON.parse(configElement.textContent) as PreviewEmbedConfig;
    let renderSession: Awaited<ReturnType<typeof createRenderSession>> | undefined;
    let renderAbortController: AbortController | undefined;
    let renderVersion = 0;
    let resizeTimer: number | undefined;
    let disposed = false;

    runEmbedSession();

    const resizeObserver = new ResizeObserver(() => {
        scheduleSessionResize();
    });
    resizeObserver.observe(root);

    window.addEventListener(WORKSPACE_FULLSCREEN_CHANGE_EVENT, scheduleSessionResize);
    window.addEventListener('beforeunload', dispose, { once: true });
    document.addEventListener('astro:before-swap', dispose, { once: true });

    function scheduleSessionResize() {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            renderSession?.resize();
        }, 120);
    }

    async function runEmbedSession() {
        if (disposed) {
            return;
        }

        const version = renderVersion + 1;
        renderVersion = version;
        renderAbortController?.abort();
        renderAbortController = new AbortController();
        renderSession?.dispose();
        renderSession = undefined;
        setPreviewState('loading', config.loadingLabel);

        try {
            const session = await createRenderSession(previewCanvas, config.code, config.accent, {
                configPanel: configPanel
                    ? {
                          container: configPanel,
                          title: config.configLabel,
                      }
                    : undefined,
                signal: renderAbortController.signal,
                renderer: config.renderer,
                onStatus(nextStatus) {
                    if (disposed || version !== renderVersion) {
                        return;
                    }

                    if (nextStatus.state === 'loading') {
                        setPreviewState('loading', nextStatus.label ?? config.loadingLabel);
                    } else {
                        setPreviewState('ready');
                    }
                },
            });

            if (disposed || version !== renderVersion) {
                session.dispose();
                return;
            }

            renderSession = session;
            renderAbortController = undefined;
        } catch (error) {
            if (disposed || version !== renderVersion) {
                return;
            }

            const message = error instanceof Error ? error.message : String(error);
            renderAbortController = undefined;
            setPreviewState('error', `${config.errorLabel}: ${message}`);

            console.error(error);
        }
    }

    function dispose() {
        disposed = true;
        window.clearTimeout(resizeTimer);
        resizeObserver.disconnect();
        window.removeEventListener(WORKSPACE_FULLSCREEN_CHANGE_EVENT, scheduleSessionResize);
        renderAbortController?.abort();
        renderAbortController = undefined;
        renderSession?.dispose();
        renderSession = undefined;
    }

    function setPreviewState(state: 'loading' | 'ready' | 'error', label?: string) {
        root.dataset.state = state;
        root.setAttribute('aria-busy', String(state === 'loading'));

        if (!status) {
            return;
        }

        if (state === 'ready') {
            status.hidden = true;
            status.textContent = '';
            return;
        }

        status.hidden = false;
        status.textContent = label ?? config.loadingLabel;
    }
}

const collapsedStorageKey = 'aholo:examples:rail-collapsed';
const widthStorageKey = 'aholo:examples:rail-width';
const defaultRailWidth = 286;
const railCollapseThreshold = 160;
const railMinWidth = 220;
const railMaxWidth = 420;
const stageMinWidth = 420;
const splitterWidth = 9;

export function mountExamplesPage(root: ParentNode = document) {
    const viewer = root.querySelector<HTMLElement>('[data-example-viewer]');
    const splitter = root.querySelector<HTMLElement>('[data-example-splitter]');

    if (!viewer || !splitter || viewer.dataset.mounted === 'true') {
        return;
    }

    viewer.dataset.mounted = 'true';

    const isCompactLayout = () => window.matchMedia('(max-width: 900px)').matches;
    let disposed = false;
    const splitPane = mountSplitPane({
        container: viewer,
        splitter,
        collapsedDatasetKey: 'paneCollapsed',
        cssProperty: '--example-rail-width',
        defaultValue: readRailWidth(),
        valueUnit: 'px',
        keyboardStep: 24,
        isDisabled: isCompactLayout,
        toggleWhenDisabled: true,
        clampValue(value, rect) {
            const maximum = getMaximumRailWidth(rect.width);
            return clamp(value, Math.min(railMinWidth, maximum), maximum);
        },
        shouldCollapse(value, rect) {
            return value <= Math.min(railCollapseThreshold, rect.width * 0.24);
        },
        getAriaValue(value, rect) {
            return rect.width > 0 ? (value / rect.width) * 100 : 0;
        },
        getInitialCollapsed: readCollapsed,
        onCollapsedChange(collapsed, { persist }) {
            if (persist) {
                writeCollapsed(collapsed);
            }
        },
        onValueChange(value, { persist }) {
            if (persist) {
                writeRailWidth(value);
            }
        },
    });
    const fullscreenMode = mountWorkspaceFullscreenMode({
        onChange() {
            handleResize();
        },
    });

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            viewer.dataset.layoutReady = 'true';
        });
    });

    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', dispose, { once: true });
    document.addEventListener('astro:before-swap', dispose, { once: true });

    function handleResize() {
        if (!splitPane.getCollapsed() && !isCompactLayout()) {
            splitPane.setSize(splitPane.getSize(), { persist: false });
        }
    }

    function dispose() {
        if (disposed) {
            return;
        }

        disposed = true;
        fullscreenMode.dispose();
        splitPane.dispose();
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('beforeunload', dispose);
        document.removeEventListener('astro:before-swap', dispose);
    }
}

function getMaximumRailWidth(viewerWidth: number) {
    return Math.max(railMinWidth, Math.min(railMaxWidth, viewerWidth - stageMinWidth - splitterWidth));
}

function readCollapsed() {
    try {
        return localStorage.getItem(collapsedStorageKey) === 'true';
    } catch {
        return false;
    }
}

function writeCollapsed(collapsed: boolean) {
    try {
        localStorage.setItem(collapsedStorageKey, String(collapsed));
    } catch {
        // Persisting the rail state is optional; resizing should still work.
    }
}

function readRailWidth() {
    try {
        const stored = Number(localStorage.getItem(widthStorageKey));

        if (Number.isFinite(stored) && stored > 0) {
            return stored;
        }
    } catch {
        // Persisting the rail width is optional; the default width is fine.
    }

    return defaultRailWidth;
}

function writeRailWidth(width: number) {
    try {
        localStorage.setItem(widthStorageKey, String(Math.round(width)));
    } catch {
        // Persisting the rail width is optional; resizing should still work.
    }
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(Math.max(value, minimum), maximum);
}
