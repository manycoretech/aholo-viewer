import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import type { FpsGraphBladeApi } from '@tweakpane/plugin-essentials';
import { createDefaultParams, restoreViewerParams, saveViewerParams, setupConfigPanel } from './viewer-config.js';
import { droppedFiles, fileSources, formatBytes, urlSources, type AssetSource } from './viewer-assets.js';
import { ViewerScene, type CoordinateSystem, type ViewId } from './viewer-scene.js';
import { mountViewerConversion } from './viewer-convert.js';
import { mountWorkspaceFullscreenMode } from './workspace-fullscreen.js';
import type { ViewerLabels } from './viewer-labels.js';

const VIEW_IDS: readonly ViewId[] = ['A', 'B', 'C', 'D'];
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;
const SPLIT_SNAP_THRESHOLD = 0.025;
const SPLIT_RELEASE_THRESHOLD = 0.05;

export function mountViewerPage(root: HTMLElement, { labels }: { labels: ViewerLabels }) {
    const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    const stage = get('[data-viewer-stage]');
    const splitters = Array.from(root.querySelectorAll<HTMLElement>('[data-splitter]'));
    const inspector = get<HTMLElement>('[data-inspector]');
    const controls = get<HTMLElement>('[data-controls]');
    const controlsToggle = get<HTMLButtonElement>('[data-controls-toggle]');
    const drawerToggle = get<HTMLButtonElement>('[data-drawer-toggle]');
    const drawerClose = get<HTMLButtonElement>('[data-drawer-close]');
    const backdrop = get<HTMLButtonElement>('[data-drawer-backdrop]');
    const fileInput = get<HTMLInputElement>('[data-file-input]');
    const globalFileInput = get<HTMLInputElement>('[data-global-file-input]');
    const fileList = get<HTMLElement>('[data-file-list]');
    const syncInput = get<HTMLInputElement>('[data-camera-sync]');
    const coordinate = get<HTMLSelectElement>('[data-camera-coord]');
    const far = get<HTMLInputElement>('[data-camera-far]');
    const orbit = get<HTMLInputElement>('[data-camera-use-orbit]');
    const notice = get<HTMLElement>('[data-notice]');
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const mobile = window.matchMedia('(max-width: 800px)');
    const views = new Map<ViewId, ViewerScene>();
    const viewNames = new Map<ViewId, string>();
    const panels = new Map<ViewId, { element: HTMLElement; config: ReturnType<typeof setupConfigPanel> }>();
    let activeId: ViewId = 'A';
    let previousActiveId: ViewId | undefined;
    let layout: 'single' | 'split' | 'quad' = 'single';
    let previewId: ViewId | undefined;
    let maximized = false;
    const splitRatios = { split: 0.5, column: 0.5, row: 0.5 };
    let endResize: (() => void) | undefined;
    let drawerOpen = false;
    let controlsOpen = false;
    let disposed = false;
    let frameId = 0;
    let previousTime = 0;

    function showError(error: unknown) {
        notice.textContent = error instanceof Error ? error.message : String(error);
        notice.hidden = false;
        setDrawer(true);
    }

    function ensureView(id: ViewId) {
        const existing = views.get(id);
        if (existing) {
            return existing;
        }
        let params = createDefaultParams();
        try {
            params = restoreViewerParams(id);
        } catch (error) {
            showError(`${labels.storageError}: ${error instanceof Error ? error.message : error}`);
        }
        const element = get<HTMLElement>(`[data-view="${id}"]`);
        const view = new ViewerScene(
            id,
            element.querySelector<HTMLElement>('[data-render-surface]')!,
            params,
            labels,
            () => {
                if (disposed) {
                    return;
                }
                const current = views.get(id);
                if (current) {
                    updateView(current);
                }
            },
        );
        views.set(id, view);
        const configElement = document.createElement('div');
        configElement.dataset.configView = id;
        get('[data-config-panel]').append(configElement);
        const config = setupConfigPanel(
            configElement,
            labels,
            params,
            () => view.keepPrecalculateDisabled,
            () => {
                view.applySettings();
                saveSettings(view);
            },
        );
        panels.set(id, { element: configElement, config });
        if (id !== activeId && syncInput.checked) {
            view.copyCameraFrom(activeView());
        }
        updateView(view);
        return view;
    }

    function destroyView(id: ViewId) {
        const view = views.get(id);
        if (!view) {
            return;
        }
        views.delete(id);
        view.dispose();
        const panel = panels.get(id)!;
        panel.config.dispose();
        panel.element.remove();
        panels.delete(id);
        viewNames.delete(id);
        viewElement(id).hidden = true;
        viewElement(id).inert = true;
    }

    function saveSettings(view: ViewerScene) {
        try {
            saveViewerParams(view.id, view.params);
        } catch {
            showError(labels.storageError);
        }
    }

    function activeView() {
        return views.get(activeId)!;
    }
    function viewElement(id: ViewId) {
        return get<HTMLElement>(`[data-view="${id}"]`);
    }
    function viewName(view: ViewerScene) {
        return (
            viewNames.get(view.id) ??
            (view.records.length === 1 ? view.records[0].source.name : `${labels.view} ${view.id}`)
        );
    }
    function setActive(id: ViewId) {
        if (id === activeId) {
            return;
        }
        ensureView(id);
        previousActiveId = activeId;
        activeId = id;
        previewId = undefined;
        syncLayout();
        updateInspector();
    }

    function syncLayout() {
        root.dataset.layout = layout;
        root.dataset.activeView = activeId;
        root.dataset.preview = previewId ?? '';
        root.dataset.maximized = String(maximized);
        const showingOne = layout === 'single' || maximized;
        for (const [id, view] of views) {
            const element = viewElement(id);
            element.hidden = showingOne && id !== (previewId ?? activeId);
            element.dataset.active = String(id === activeId);
            element.inert = element.hidden || previewId !== undefined;
            view.control.enabled = !element.hidden && previewId === undefined && !endResize && !view.contextLost;
            element.querySelector('[data-activate-view]')?.setAttribute('aria-pressed', String(id === activeId));
            element.querySelector<HTMLElement>('[data-view-label]')!.dataset.active = String(id === activeId);
            element.querySelector<HTMLElement>('[data-preview-label]')!.hidden = previewId !== id;
            panels.get(id)!.element.hidden = id !== activeId;
            if (!element.hidden) {
                view.resize();
            }
        }
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-select-view]')) {
            const id = button.dataset.selectView as ViewId;
            button.hidden = !views.has(id);
            button.setAttribute('aria-pressed', String(id === (previewId ?? activeId)));
        }
        for (const button of root.querySelectorAll('[data-layout-button]')) {
            button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.layoutButton === layout));
        }
        syncInput.disabled = views.size < 2;
        get('[data-view-switcher]').hidden = !showingOne || views.size < 2;
        root.dataset.multipleViews = String(views.size > 1);
        updateSplitters();
    }

    function splitAxis(splitter: HTMLElement) {
        return layout === 'split' && mobile.matches ? 'row' : splitter.dataset.splitter;
    }

    function splitRatioKey(splitter: HTMLElement) {
        return layout === 'split' ? 'split' : (splitter.dataset.splitter as 'column' | 'row');
    }

    function updateSplitters() {
        stage.style.setProperty(
            '--split-column',
            `${(layout === 'split' ? splitRatios.split : splitRatios.column) * 100}%`,
        );
        stage.style.setProperty('--split-row', `${splitRatios.row * 100}%`);
        for (const splitter of splitters) {
            const horizontal = splitAxis(splitter) === 'row';
            splitter.hidden =
                maximized || layout === 'single' || (layout === 'split' && splitter.dataset.splitter === 'row');
            splitter.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
            splitter.setAttribute('aria-label', horizontal ? labels.resizeRows : labels.resizeColumns);
            splitter.setAttribute('aria-valuenow', String(Math.round(splitRatios[splitRatioKey(splitter)] * 100)));
        }
    }

    function setSplitRatio(splitter: HTMLElement, ratio: number) {
        splitRatios[splitRatioKey(splitter)] = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
        updateSplitters();
    }

    for (const splitter of splitters) {
        splitter.addEventListener('dblclick', () => setSplitRatio(splitter, 0.5), { signal });
        splitter.addEventListener(
            'keydown',
            event => {
                if (event.key === 'Home' || event.key === 'Enter') {
                    event.preventDefault();
                    setSplitRatio(splitter, 0.5);
                    return;
                }
                const keys = splitAxis(splitter) === 'column' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
                const direction = keys.indexOf(event.key);
                if (direction !== -1) {
                    event.preventDefault();
                    setSplitRatio(splitter, splitRatios[splitRatioKey(splitter)] + (direction === 0 ? -0.02 : 0.02));
                }
            },
            { signal },
        );
        splitter.addEventListener(
            'pointerdown',
            event => {
                if (event.button !== 0) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                endResize?.();
                splitter.focus({ preventScroll: true });
                splitter.setPointerCapture(event.pointerId);
                const axis = splitAxis(splitter);
                stage.dataset.resizing = axis;
                let snapped = Math.abs(splitRatios[splitRatioKey(splitter)] - 0.5) <= SPLIT_SNAP_THRESHOLD;
                for (const view of views.values()) {
                    view.control.stop();
                    view.control.enabled = false;
                }
                const move = (moveEvent: PointerEvent) => {
                    if (moveEvent.pointerId !== event.pointerId) {
                        return;
                    }
                    const rect = stage.getBoundingClientRect();
                    let ratio =
                        axis === 'column'
                            ? (moveEvent.clientX - rect.left) / rect.width
                            : (moveEvent.clientY - rect.top) / rect.height;
                    const distance = Math.abs(ratio - 0.5);
                    snapped = distance <= (snapped ? SPLIT_RELEASE_THRESHOLD : SPLIT_SNAP_THRESHOLD);
                    if (snapped) {
                        ratio = 0.5;
                    }
                    splitter.classList.toggle('is-snapped', snapped);
                    setSplitRatio(splitter, ratio);
                };
                const stop = () => {
                    splitter.removeEventListener('pointermove', move);
                    splitter.removeEventListener('pointerup', stop);
                    splitter.removeEventListener('pointercancel', stop);
                    splitter.removeEventListener('lostpointercapture', stop);
                    if (splitter.hasPointerCapture(event.pointerId)) {
                        splitter.releasePointerCapture(event.pointerId);
                    }
                    splitter.classList.remove('is-snapped');
                    delete stage.dataset.resizing;
                    endResize = undefined;
                    if (!disposed) {
                        syncLayout();
                    }
                };
                endResize = stop;
                splitter.addEventListener('pointermove', move);
                splitter.addEventListener('pointerup', stop);
                splitter.addEventListener('pointercancel', stop);
                splitter.addEventListener('lostpointercapture', stop);
            },
            { signal },
        );
    }

    function syncCameras(source = activeView()) {
        if (!syncInput.checked) {
            return;
        }
        for (const view of views.values()) {
            if (view !== source) {
                view.copyCameraFrom(source);
            }
        }
    }

    function updateView(view: ViewerScene) {
        const element = viewElement(view.id);
        const loading = view.records.filter(record => record.status === 'loading').length;
        const status = element.querySelector<HTMLElement>('[data-view-status]')!;
        const message = element.querySelector<HTMLElement>('[data-view-message]')!;
        const reload = element.querySelector<HTMLButtonElement>('[data-view-reload]')!;
        const empty = element.querySelector<HTMLElement>('[data-empty-scene]')!;
        empty.hidden = view.records.length > 0 || view.contextLost;
        status.hidden = !loading && !view.contextLost;
        status.dataset.state = view.contextLost ? 'lost' : 'loading';
        message.textContent = view.contextLost
            ? `${labels.lostTitle}\n${labels.lostHint}`
            : `${labels.loading} ${loading}`;
        reload.hidden = !view.contextLost;
        element.querySelector<HTMLElement>('[data-view-title]')!.textContent = viewName(view);
        panels.get(view.id)?.config.refreshProgrammatic();
        if (view.id === activeId) {
            updateInspector();
        }
    }

    function updateInspector() {
        const view = views.get(activeId);
        if (!view) {
            return;
        }
        coordinate.value = view.coordinateSystem;
        const title = get<HTMLElement>('[data-inspector-view-title]');
        title.textContent = viewName(view);
        title.title = viewName(view);
        far.value = String(view.camera.far);
        orbit.checked = view.control.useOrbit;
        for (const element of root.querySelectorAll<HTMLElement>('[data-active-view-id]')) {
            element.textContent = view.id;
        }
        fileInput.disabled = view.contextLost;
        get<HTMLButtonElement>('[data-clipboard-load]').disabled = view.contextLost;
        get<HTMLInputElement>('[data-url-input]').disabled = view.contextLost;
        get<HTMLButtonElement>('[data-clear-scene]').hidden = view.records.length === 0;
        renderFiles(view);
    }

    function renderFiles(view: ViewerScene) {
        fileList.replaceChildren();
        const summary = get('[data-asset-summary]');
        const ready = view.records.filter(record => record.status === 'ready');
        const count = ready.reduce((total, record) => total + (record.asset?.splatCount ?? 0), 0);
        summary.textContent = `${view.records.length} ${labels.filesCount}${count ? ` · ${count.toLocaleString()} GS` : ''}`;
        if (!view.records.length) {
            const empty = document.createElement('li');
            empty.className = 'viewer-empty-file';
            empty.textContent = labels.emptyFiles;
            fileList.append(empty);
        }
        for (const record of view.records) {
            const item = document.createElement('li');
            item.className = 'viewer-file-item';
            item.dataset.state = record.status;
            item.dataset.recordId = String(record.id);
            const header = document.createElement('div');
            header.className = 'viewer-file-heading';
            const name = document.createElement('strong');
            name.textContent = record.source.name;
            name.title = record.source.name;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'viewer-icon-button';
            remove.dataset.removeFile = String(record.id);
            remove.title = `${record.status === 'loading' ? labels.cancel : labels.removeFile}: ${record.source.name}`;
            remove.setAttribute('aria-label', remove.title);
            remove.innerHTML =
                '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6m4-6v6" /></svg>';
            header.append(name, remove);
            const stats = document.createElement('div');
            stats.className = 'viewer-file-stats';
            const values = [
                record.asset?.format ?? record.source.name.split('.').pop()?.toUpperCase(),
                formatBytes(record.source.kind === 'file' ? record.source.file.size : undefined),
            ];
            if (record.asset?.splatCount !== undefined) {
                values.push(`${record.asset.splatCount.toLocaleString()} GS`, `SH ${record.asset.shDegree ?? '—'}`);
            }
            if (record.asset?.meshCount !== undefined) {
                values.push(`${record.asset.meshCount} ${labels.meshes}`);
            }
            for (const value of values) {
                const stat = document.createElement('span');
                stat.textContent = value ?? '';
                stats.append(stat);
            }
            item.append(header, stats);
            if (record.status === 'loading') {
                const loading = document.createElement('span');
                loading.className = 'viewer-file-progress';
                loading.textContent = labels.loading;
                item.append(loading);
            }
            if (record.error) {
                const error = document.createElement('p');
                error.className = 'viewer-file-error';
                error.textContent = record.error;
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'viewer-text-button';
                retry.dataset.retryFile = String(record.id);
                retry.textContent = labels.retry;
                item.append(error, retry);
            }
            fileList.append(item);
        }
    }

    function setDrawer(open: boolean) {
        drawerOpen = open;
        root.dataset.drawerOpen = String(open);
        inspector.inert = !open;
        backdrop.hidden = !open || !mobile.matches;
        drawerToggle.setAttribute('aria-expanded', String(open));
        controls.inert = !controlsOpen || (mobile.matches && open);
        controlsToggle.inert = mobile.matches && open;
        stage.inert = mobile.matches && open;
        inspector.setAttribute('role', mobile.matches ? 'dialog' : 'complementary');
        if (mobile.matches) {
            inspector.setAttribute('aria-modal', String(open));
        } else {
            inspector.removeAttribute('aria-modal');
        }
        if (open && mobile.matches) {
            drawerClose.focus({ preventScroll: true });
        }
    }

    function setControlsOpen(open: boolean) {
        controlsOpen = open;
        root.dataset.controlsOpen = String(open);
        controls.inert = !open || (mobile.matches && drawerOpen);
        controlsToggle.hidden = open;
        controlsToggle.setAttribute('aria-expanded', String(open));
    }

    function focusControls() {
        if (controlsOpen) {
            drawerToggle.focus();
        } else {
            controlsToggle.focus();
        }
    }

    async function load(sources: AssetSource[], view = activeView(), append = true) {
        notice.hidden = true;
        try {
            await view.importSources(sources, append);
            if (!disposed && views.get(view.id) === view) {
                syncCameras(view);
                updateInspector();
            }
        } catch (error) {
            if (!disposed) {
                showError(error);
            }
        }
    }

    async function loadAll(sources: AssetSource[]) {
        await Promise.all([...views.values()].map(view => load(sources, view, false)));
    }

    globalFileInput.addEventListener(
        'change',
        () => {
            const sources = fileSources(
                Array.from(globalFileInput.files ?? [], file => ({ file, path: file.webkitRelativePath || file.name })),
            );
            globalFileInput.value = '';
            void loadAll(sources);
        },
        { signal },
    );
    get<HTMLFormElement>('[data-global-url-form]').addEventListener(
        'submit',
        event => {
            event.preventDefault();
            try {
                void loadAll(urlSources(get<HTMLInputElement>('[data-global-url-input]').value));
            } catch (error) {
                showError(error);
            }
        },
        { signal },
    );
    get('[data-global-clipboard-load]').addEventListener(
        'click',
        () => {
            void navigator.clipboard
                .readText()
                .then(text => {
                    get<HTMLInputElement>('[data-global-url-input]').value = text;
                    return loadAll(urlSources(text));
                })
                .catch(showError);
        },
        { signal },
    );

    fileInput.addEventListener(
        'change',
        () => {
            const sources = fileSources(
                Array.from(fileInput.files ?? [], file => ({ file, path: file.webkitRelativePath || file.name })),
            );
            fileInput.value = '';
            void load(sources);
        },
        { signal },
    );
    if (
        /iP(?:ad|hone|od)/u.test(navigator.userAgent) ||
        (/Macintosh/u.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    ) {
        for (const input of root.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
            input.removeAttribute('accept');
        }
    }
    get<HTMLFormElement>('[data-url-form]').addEventListener(
        'submit',
        event => {
            event.preventDefault();
            try {
                void load(urlSources(get<HTMLInputElement>('[data-url-input]').value));
            } catch (error) {
                showError(error);
            }
        },
        { signal },
    );
    get('[data-clipboard-load]').addEventListener(
        'click',
        () => {
            void navigator.clipboard
                .readText()
                .then(text => {
                    get<HTMLInputElement>('[data-url-input]').value = text;
                    return load(urlSources(text));
                })
                .catch(showError);
        },
        { signal },
    );

    root.addEventListener(
        'click',
        event => {
            const button = (event.target as Element).closest<HTMLElement>('button');
            if (!button) {
                return;
            }
            const data = button.dataset;
            if (data.layoutButton) {
                endResize?.();
                previewId = undefined;
                maximized = false;
                layout = data.layoutButton as typeof layout;
                const count = { single: 1, split: 2, quad: 4 }[layout];
                VIEW_IDS.slice(count).forEach(destroyView);
                if (!views.has(activeId)) {
                    activeId = 'A';
                }
                if (previousActiveId && !views.has(previousActiveId)) {
                    previousActiveId = undefined;
                }
                VIEW_IDS.slice(0, count).forEach(ensureView);
                syncLayout();
                updateInspector();
            } else if (data.selectView || data.activateView) {
                setActive((data.selectView ?? data.activateView) as ViewId);
                activeView().surface.focus({ preventScroll: true });
            } else if (data.emptyImport) {
                setActive(data.emptyImport as ViewId);
                fileInput.click();
            } else if ('drawerToggle' in data) {
                setDrawer(!drawerOpen);
            } else if ('drawerClose' in data || 'drawerBackdrop' in data) {
                setDrawer(false);
                focusControls();
            } else if ('controlsToggle' in data) {
                setControlsOpen(true);
            } else if ('controlsClose' in data) {
                setControlsOpen(false);
                controlsToggle.focus();
            } else if ('clearScene' in data) {
                activeView().clear();
            } else if (data.removeFile) {
                activeView().remove(Number(data.removeFile));
            } else if (data.retryFile) {
                const view = activeView();
                const record = view.records.find(value => value.id === Number(data.retryFile));
                if (record) {
                    const { source } = record;
                    view.remove(record.id);
                    void load([source], view, true);
                }
            } else if ('viewReload' in data) {
                window.location.reload();
            } else if ('settingsReset' in data) {
                const view = activeView();
                Object.assign(view.params, createDefaultParams());
                if (view.keepPrecalculateDisabled) {
                    view.params.precalculateEnabled = false;
                }
                view.applySettings();
                panels.get(activeId)!.config.refreshProgrammatic();
                saveSettings(view);
            } else if ('cameraFrame' in data) {
                activeView().frameModels();
                syncCameras();
                updateInspector();
            } else if ('cameraReset' in data) {
                activeView().setCoordinateSystem(activeView().coordinateSystem);
                syncCameras();
                updateInspector();
            } else if ('cameraCopy' in data) {
                void navigator.clipboard.writeText(JSON.stringify(cameraState(activeView()))).catch(showError);
            } else if ('cameraPaste' in data) {
                void navigator.clipboard
                    .readText()
                    .then(text => {
                        applyCameraState(activeView(), JSON.parse(text), labels.invalidCamera);
                        syncCameras();
                        updateInspector();
                    })
                    .catch(showError);
            }
        },
        { signal },
    );
    root.addEventListener(
        'pointerdown',
        event => {
            const pane = (event.target as Element).closest<HTMLElement>('[data-view]');
            if (pane && !previewId) {
                setActive(pane.dataset.view as ViewId);
            }
        },
        { signal },
    );
    stage.addEventListener(
        'dblclick',
        event => {
            const surface = (event.target as Element).closest<HTMLElement>('[data-render-surface]');
            if (!surface || layout === 'single') {
                return;
            }
            event.preventDefault();
            setActive(surface.closest<HTMLElement>('[data-view]')!.dataset.view as ViewId);
            maximized = !maximized;
            previewId = undefined;
            syncLayout();
            activeView().surface.focus({ preventScroll: true });
        },
        { signal },
    );
    coordinate.addEventListener(
        'change',
        () => {
            activeView().setCoordinateSystem(coordinate.value as CoordinateSystem);
            syncCameras();
        },
        { signal },
    );
    orbit.addEventListener(
        'change',
        () => {
            activeView().control.setOptions({ useOrbit: orbit.checked });
        },
        { signal },
    );
    far.addEventListener(
        'change',
        () => {
            const value = Number(far.value);
            if (Number.isFinite(value) && value > activeView().camera.near) {
                activeView().camera.far = value;
                activeView().camera.updateProjectionMatrix();
                syncCameras();
            } else {
                far.value = String(activeView().camera.far);
            }
        },
        { signal },
    );
    syncInput.addEventListener('change', () => syncCameras(), { signal });

    for (const element of root.querySelectorAll<HTMLElement>('[data-view]')) {
        const id = element.dataset.view as ViewId;
        let dragDepth = 0;
        const viewLabel = element.querySelector<HTMLElement>('[data-view-label]')!;
        const nameButton = element.querySelector<HTMLButtonElement>('[data-activate-view]')!;
        const nameInput = element.querySelector<HTMLInputElement>('[data-view-name-input]')!;
        viewLabel.addEventListener(
            'dblclick',
            event => {
                if (!nameInput.hidden) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                const view = views.get(id)!;
                nameInput.value = viewName(view);
                nameButton.hidden = true;
                nameInput.hidden = false;
                nameInput.focus({ preventScroll: true });
                nameInput.select();
            },
            { signal },
        );
        nameInput.addEventListener(
            'blur',
            () => {
                const name = nameInput.value.trim();
                if (name) {
                    viewNames.set(id, name);
                } else {
                    viewNames.delete(id);
                }
                nameInput.hidden = true;
                nameButton.hidden = false;
                updateView(views.get(id)!);
            },
            { signal },
        );
        const overlay = element.querySelector<HTMLElement>('[data-drop-target]')!;
        const dropLabel = element.querySelector<HTMLElement>('[data-drop-label]')!;
        const dropHint = element.querySelector<HTMLElement>('[data-drop-hint]')!;
        const showDropTarget = (event: DragEvent) => {
            const hasAssets = Boolean(views.get(id)?.records.length);
            const append = event.ctrlKey;
            dropLabel.textContent = hasAssets ? (append ? labels.dropAppend : labels.dropReplace) : labels.emptyScene;
            dropHint.textContent = hasAssets ? labels.dropHint : labels.emptyHint;
            overlay.hidden = false;
        };
        const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
        element.addEventListener(
            'dragenter',
            event => {
                if (!isFileDrag(event)) {
                    return;
                }
                event.preventDefault();
                dragDepth++;
                showDropTarget(event);
            },
            { signal },
        );
        element.addEventListener(
            'dragover',
            event => {
                if (!isFileDrag(event)) {
                    return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'copy';
                }
                showDropTarget(event);
            },
            { signal },
        );
        element.addEventListener(
            'dragleave',
            event => {
                if (!isFileDrag(event)) {
                    return;
                }
                dragDepth = Math.max(0, dragDepth - 1);
                overlay.hidden = dragDepth === 0;
            },
            { signal },
        );
        element.addEventListener(
            'drop',
            event => {
                if (!event.dataTransfer || !isFileDrag(event)) {
                    return;
                }
                event.preventDefault();
                overlay.hidden = true;
                dragDepth = 0;
                setActive(id);
                const view = ensureView(id);
                const append = event.ctrlKey;
                void droppedFiles(event.dataTransfer)
                    .then(files => load(fileSources(files), view, append))
                    .catch(showError);
            },
            { signal },
        );
    }

    root.addEventListener(
        'dragover',
        event => {
            if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
                event.preventDefault();
            }
        },
        { signal },
    );
    root.addEventListener(
        'drop',
        event => {
            if (
                (event.target as Element).closest('[data-view]') ||
                !event.dataTransfer ||
                !Array.from(event.dataTransfer.types).includes('Files')
            ) {
                return;
            }
            event.preventDefault();
            const view = activeView();
            const append = event.ctrlKey;
            void droppedFiles(event.dataTransfer)
                .then(files => load(fileSources(files), view, append))
                .catch(showError);
        },
        { signal },
    );

    function stopPreview() {
        if (previewId) {
            previewId = undefined;
            syncLayout();
            activeView().surface.focus({ preventScroll: true });
        }
    }
    document.addEventListener(
        'keydown',
        event => {
            const target = event.target as Element | null;
            const editing = Boolean(target?.closest('input,textarea,select,[contenteditable="true"]'));
            if (event.key === 'Escape' && !editing && drawerOpen) {
                setDrawer(false);
                focusControls();
                return;
            }
            if (event.key === 'Escape' && !editing && maximized) {
                maximized = false;
                previewId = undefined;
                syncLayout();
                activeView().surface.focus({ preventScroll: true });
                return;
            }
            if (!editing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat) {
                const id = VIEW_IDS[Number(event.key) - 1];
                if (id && views.has(id) && !(mobile.matches && drawerOpen)) {
                    event.preventDefault();
                    setActive(id);
                    activeView().surface.focus({ preventScroll: true });
                    return;
                }
            }
            if (event.key === 'Tab' && mobile.matches && drawerOpen) {
                const elements = Array.from(
                    inspector.querySelectorAll<HTMLElement>(
                        'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
                    ),
                ).filter(element => element.offsetParent !== null);
                const first = elements[0];
                const last = elements.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
            if (
                event.code !== 'Space' ||
                event.repeat ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                target?.closest('input,textarea,select,button,summary,[contenteditable="true"],.tp-rotv') ||
                (layout !== 'single' && !maximized) ||
                views.size < 2
            ) {
                return;
            }
            event.preventDefault();
            previewId =
                previousActiveId && views.has(previousActiveId)
                    ? previousActiveId
                    : VIEW_IDS.find(id => id !== activeId && views.has(id));
            syncLayout();
        },
        { signal },
    );
    window.addEventListener(
        'keyup',
        event => {
            if (event.code === 'Space') {
                stopPreview();
            }
        },
        { signal },
    );
    window.addEventListener('blur', stopPreview, { signal });
    window.addEventListener('blur', () => endResize?.(), { signal });
    mobile.addEventListener(
        'change',
        () => {
            endResize?.();
            updateSplitters();
            setDrawer(false);
        },
        { signal },
    );

    const fpsPane = new Pane({ container: get('[data-fps-graph]') });
    fpsPane.registerPlugin(EssentialsPlugin);
    const fps = fpsPane.addBlade({ view: 'fpsgraph', rows: 2 }) as FpsGraphBladeApi;
    fps.on('tick', () => {
        get('[data-fps]').textContent = fps.fps === null ? '-- FPS' : `${Math.round(fps.fps)} FPS`;
    });
    const conversion = mountViewerConversion(root, labels);
    setDrawer(false);
    ensureView('A');
    syncLayout();
    setControlsOpen(true);
    const resize = () => {
        for (const view of views.values()) {
            if (!viewElement(view.id).hidden) {
                view.resize();
            }
        }
    };
    const resizeObserver = new ResizeObserver(resize);
    for (const element of root.querySelectorAll<HTMLElement>('[data-render-surface]')) {
        resizeObserver.observe(element);
    }
    const fullscreen = mountWorkspaceFullscreenMode({ onChange: resize });

    function tick(time: number) {
        if (disposed) {
            return;
        }
        fps.begin();
        const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.1) : 0;
        previousTime = time;
        let moved: ViewerScene | undefined;
        for (const view of views.values()) {
            if (view.control.enabled && view.control.update(delta)) {
                moved = view;
            }
        }
        if (moved) {
            syncCameras(moved);
        }
        for (const view of views.values()) {
            if (!viewElement(view.id).hidden) {
                view.render();
            }
        }
        fps.end();
        frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        endResize?.();
        lifetime.abort();
        cancelAnimationFrame(frameId);
        resizeObserver.disconnect();
        fullscreen.dispose();
        conversion.dispose();
        fpsPane.dispose();
        for (const id of views.keys()) {
            destroyView(id);
        }
    }
    window.addEventListener('beforeunload', dispose, { signal, once: true });
    document.addEventListener('astro:before-swap', dispose, { signal, once: true });
    return { dispose };
}

function cameraState(view: ViewerScene) {
    const { camera } = view;
    return {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        rotation: { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z, order: camera.rotation.order },
        up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        orbitCenter: view.control.getState().orbitCenter,
    };
}

function applyCameraState(view: ViewerScene, state: unknown, errorMessage: string) {
    if (!state || typeof state !== 'object') {
        throw new Error(errorMessage);
    }
    const value = state as ReturnType<typeof cameraState>;
    const vectorValid = (vector: { x: number; y: number; z: number } | undefined) =>
        vector && [vector.x, vector.y, vector.z].every(Number.isFinite);
    if (
        !vectorValid(value.position) ||
        !vectorValid(value.rotation) ||
        !vectorValid(value.up) ||
        !['XYZ', 'YZX', 'ZXY', 'XZY', 'YXZ', 'ZYX'].includes(value.rotation.order) ||
        ![value.fov, value.near, value.far].every(Number.isFinite) ||
        value.fov <= 0 ||
        value.fov >= 180 ||
        value.near <= 0 ||
        value.far <= value.near ||
        (value.orbitCenter !== undefined && !vectorValid(value.orbitCenter))
    ) {
        throw new Error(errorMessage);
    }
    const { camera } = view;
    camera.position.set(value.position.x, value.position.y, value.position.z);
    camera.rotation.order = value.rotation.order;
    camera.rotation.set(value.rotation.x, value.rotation.y, value.rotation.z);
    camera.up.set(value.up.x, value.up.y, value.up.z);
    camera.fov = value.fov;
    camera.near = value.near;
    camera.far = value.far;
    camera.updateProjectionMatrix();
    if (value.orbitCenter) {
        view.control.setOrbitCenter(value.orbitCenter);
    }
    view.control.stop();
}
