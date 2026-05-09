export const WORKSPACE_FULLSCREEN_CHANGE_EVENT = 'aholo:workspace-fullscreenchange';

type WorkspaceFullscreenSource = 'query' | 'keyboard' | 'browser' | 'none';

interface WorkspaceFullscreenChangeDetail {
    active: boolean;
    source: WorkspaceFullscreenSource;
}

interface WorkspaceFullscreenOptions {
    onChange?: (active: boolean, detail: WorkspaceFullscreenChangeDetail) => void;
}

interface WorkspaceFullscreenController {
    dispose(): void;
}

const fullscreenQueryParam = 'fullscreen';
const viewQueryParam = 'view';
const fullscreenViewValue = 'fullscreen';
const keyboardEnterGraceMs = 900;
const keyboardExitSuppressMs = 900;
const fullscreenViewportTolerance = 12;
const browserChromeTolerance = 24;
const browserFullscreenPollMs = 250;
const truthyValues = new Set(['1', 'true', 'yes', 'on']);
const falsyValues = new Set(['0', 'false', 'no', 'off']);

export function mountWorkspaceFullscreenMode(options: WorkspaceFullscreenOptions = {}): WorkspaceFullscreenController {
    let queryMode = readQueryMode();
    let keyboardRequested = false;
    let observedBrowserFullscreen = false;
    let keyboardEnterDeadline = 0;
    let browserSuppressUntil = 0;
    let active = false;
    let source: WorkspaceFullscreenSource = 'none';
    let frameId: number | undefined;
    let stateTimer: number | undefined;
    let browserPollTimer: number | undefined;
    let disposed = false;

    sync();

    window.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('resize', scheduleSync);
    window.visualViewport?.addEventListener('resize', scheduleSync);
    document.addEventListener('fullscreenchange', scheduleSync);
    window.addEventListener('popstate', handlePopState);

    return {
        dispose() {
            if (disposed) {
                return;
            }

            disposed = true;

            if (frameId !== undefined) {
                window.cancelAnimationFrame(frameId);
                frameId = undefined;
            }

            clearStateTimer();
            clearBrowserPollTimer();

            window.removeEventListener('keydown', handleKeydown, true);
            window.removeEventListener('resize', scheduleSync);
            window.visualViewport?.removeEventListener('resize', scheduleSync);
            document.removeEventListener('fullscreenchange', scheduleSync);
            window.removeEventListener('popstate', handlePopState);
        },
    };

    function handleKeydown(event: KeyboardEvent) {
        if (event.key !== 'F11' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }

        if (queryMode !== undefined) {
            return;
        }

        const now = performance.now();

        if (active) {
            keyboardRequested = false;
            observedBrowserFullscreen = false;
            keyboardEnterDeadline = 0;
            browserSuppressUntil = now + keyboardExitSuppressMs;
            scheduleStateSync(keyboardExitSuppressMs);
        } else {
            keyboardRequested = true;
            observedBrowserFullscreen = false;
            keyboardEnterDeadline = now + keyboardEnterGraceMs;
            browserSuppressUntil = 0;
            scheduleStateSync(keyboardEnterGraceMs);
        }

        sync();
    }

    function handlePopState() {
        queryMode = readQueryMode();
        sync();
    }

    function scheduleSync() {
        if (frameId !== undefined) {
            return;
        }

        frameId = window.requestAnimationFrame(() => {
            frameId = undefined;
            sync();
        });
    }

    function scheduleStateSync(delay: number) {
        if (stateTimer !== undefined) {
            clearStateTimer();
        }

        stateTimer = window.setTimeout(
            () => {
                stateTimer = undefined;
                sync();
            },
            Math.max(0, delay),
        );
    }

    function clearStateTimer() {
        if (stateTimer === undefined) {
            return;
        }

        window.clearTimeout(stateTimer);
        stateTimer = undefined;
    }

    function syncBrowserPollTimer() {
        if (active && source === 'browser') {
            if (browserPollTimer === undefined) {
                browserPollTimer = window.setInterval(sync, browserFullscreenPollMs);
            }
            return;
        }

        clearBrowserPollTimer();
    }

    function clearBrowserPollTimer() {
        if (browserPollTimer === undefined) {
            return;
        }

        window.clearInterval(browserPollTimer);
        browserPollTimer = undefined;
    }

    function sync() {
        const nextState = getNextState();

        if (active === nextState.active && source === nextState.source) {
            syncDataset(nextState.active);
            syncBrowserPollTimer();
            return;
        }

        active = nextState.active;
        source = nextState.source;
        syncDataset(nextState.active);
        syncBrowserPollTimer();

        const detail = {
            active: nextState.active,
            source: nextState.source,
        };
        window.dispatchEvent(
            new CustomEvent<WorkspaceFullscreenChangeDetail>(WORKSPACE_FULLSCREEN_CHANGE_EVENT, {
                detail,
            }),
        );
        options.onChange?.(nextState.active, detail);
    }

    function getNextState(): WorkspaceFullscreenChangeDetail {
        if (queryMode !== undefined) {
            keyboardRequested = false;
            observedBrowserFullscreen = false;
            browserSuppressUntil = 0;
            clearStateTimer();

            return {
                active: queryMode,
                source: queryMode ? 'query' : 'none',
            };
        }

        const now = performance.now();
        const browserFullscreen = document.fullscreenElement !== null || isBrowserFullscreenViewport();
        const browserSuppressed = browserSuppressUntil > now;

        if (browserFullscreen) {
            observedBrowserFullscreen = true;
        }

        if (browserFullscreen && !browserSuppressed) {
            keyboardRequested = false;
            keyboardEnterDeadline = 0;
            clearStateTimer();

            return {
                active: true,
                source: 'browser',
            };
        }

        if (browserSuppressed) {
            scheduleStateSync(browserSuppressUntil - now);
        } else if (browserSuppressUntil > 0) {
            browserSuppressUntil = 0;
        }

        if (keyboardRequested) {
            if (observedBrowserFullscreen && !browserFullscreen) {
                keyboardRequested = false;
                observedBrowserFullscreen = false;
                keyboardEnterDeadline = 0;
                clearStateTimer();

                return {
                    active: false,
                    source: 'none',
                };
            }

            if (keyboardEnterDeadline > now) {
                scheduleStateSync(keyboardEnterDeadline - now);

                return {
                    active: true,
                    source: 'keyboard',
                };
            }

            keyboardRequested = false;
            observedBrowserFullscreen = false;
            keyboardEnterDeadline = 0;
            clearStateTimer();
        }

        return {
            active: false,
            source: 'none',
        };
    }
}

function readQueryMode() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(fullscreenQueryParam);

    if (value !== null) {
        const normalized = value.trim().toLowerCase();

        if (truthyValues.has(normalized) || normalized === '') {
            return true;
        }

        if (falsyValues.has(normalized)) {
            return false;
        }
    }

    return params.get(viewQueryParam)?.trim().toLowerCase() === fullscreenViewValue ? true : undefined;
}

function syncDataset(active: boolean) {
    const root = document.documentElement;
    const body = document.body;

    if (active) {
        root.dataset.workspaceFullscreen = 'true';
        if (body) {
            body.dataset.workspaceFullscreen = 'true';
        }
        return;
    }

    delete root.dataset.workspaceFullscreen;
    if (body) {
        delete body.dataset.workspaceFullscreen;
    }
}

function isBrowserFullscreenViewport() {
    if (!canInferBrowserFullscreenViewport()) {
        return false;
    }

    const { screen } = window;
    const targetWidth = Math.max(screen.width, screen.availWidth);
    const targetHeight = Math.max(screen.height, screen.availHeight);

    if (!targetWidth || !targetHeight || !window.outerWidth || !window.outerHeight) {
        return false;
    }

    const fillsScreen =
        window.innerWidth >= targetWidth - fullscreenViewportTolerance &&
        window.innerHeight >= targetHeight - fullscreenViewportTolerance;
    const browserChromeHidden =
        Math.abs(window.outerWidth - window.innerWidth) <= browserChromeTolerance &&
        Math.abs(window.outerHeight - window.innerHeight) <= browserChromeTolerance;

    return fillsScreen && browserChromeHidden;
}

function canInferBrowserFullscreenViewport() {
    // Mobile browsers often report a screen-filling viewport during normal browsing.
    return !window.matchMedia('(max-width: 900px), (hover: none), (pointer: coarse)').matches;
}
