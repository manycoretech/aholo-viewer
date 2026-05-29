import {
    BackgroundMode,
    Color,
    PerspectiveCamera,
    Scene3D,
    SplatLoader,
    SplatUtils,
    ToneMapping,
    Vector3,
    createViewer,
    createViewerContext,
    setViewerConfig,
    type Object3D,
    type Viewer,
} from '@manycore/aholo-viewer';
import { Pane } from 'tweakpane';
import { CameraControl } from './camera-control';
import {
    abortable as abortableWithMessage,
    syncCameraAspect,
    throwIfAborted as throwIfAbortedWithMessage,
} from './rendering';
import { mountWorkspaceFullscreenMode } from './workspace-fullscreen';

const { SplatFileType, SplatPackType, detectSplatFileType, parseSplatData } = SplatLoader;
const { LodSplat, createSplat } = SplatUtils;
const LOD_MAGIC_CODE = 0x262834;
const VIEWER_ABORT_MESSAGE = 'Viewer loading was aborted.';
const LEFT_RAIL_COLLAPSED_STORAGE_KEY = 'aholo:viewer:left-collapsed';
const RIGHT_RAIL_COLLAPSED_STORAGE_KEY = 'aholo:viewer:right-collapsed';
const FPS_DISPLAY_INTERVAL_MS = 250;
const FPS_SMOOTHING_FACTOR = 0.08;
const SUPPORTED_FILE_EXTENSIONS = ['.ply', '.spz', '.splat', '.ksplat', '.lcc', '.sog', '.esz', '.json'] as const;

type SplatFileTypeValue = (typeof SplatFileType)[keyof typeof SplatFileType];
type SplatPackTypeValue = (typeof SplatPackType)[keyof typeof SplatPackType];
type ToneMappingValue = (typeof ToneMapping)[keyof typeof ToneMapping];
type SplattingPresetId = 'custom' | 'maxQuality' | 'qualityFirst' | 'performanceFirst' | 'extremePerformance';
type SplatObject = Awaited<ReturnType<typeof createSplat>>;
type LodSplatInstance = InstanceType<typeof LodSplat>;
type LodMeta = ConstructorParameters<typeof LodSplat>[0] & {
    counts?: number;
    files?: string[];
    levels?: number;
    magicCode?: number;
    type?: string;
};

interface ViewerPageConfig {
    labels: ViewerLabels;
}

interface ViewerLabels {
    settings: string;
    preset: string;
    presetCustom: string;
    presetMaxQuality: string;
    presetQualityFirst: string;
    presetPerformanceFirst: string;
    presetExtremePerformance: string;
    presetPackTypeTip: string;
    packTypeTip: string;
    statusReady: string;
    statusLoading: string;
    statusError: string;
    unsupportedFileType: string;
    emptyFiles: string;
    removeFile: string;
}

type Source =
    | {
          kind: 'file';
          file: File;
          name: string;
          size: number;
      }
    | {
          kind: 'url';
          url: string;
          name: string;
          size?: number;
      };

interface FileRecord {
    name: string;
    format: string;
    size: string;
    status: 'loading' | 'ready' | 'error';
    error?: string;
}

interface ViewerParams {
    splattingPreset: SplattingPresetId;
    pixelRatio: number;
    splatPackType: SplatPackTypeValue;
    maxSh: number;
    maxStdDev: number;
    packHighPrecisionEnabled: boolean;
    precalculateEnabled: boolean;
    repackEnabled: boolean;
    renderAttachHighPrecisionEnabled: boolean;
    normalizedFalloff: boolean;
    preBlurAmount: number;
    blurAmount: number;
    focalAdjustment: number;
    detailCullingThreshold: number;
    maxPixelRadius: number;
    sortRadial: boolean;
    sortMinDuration: number;
    sortSplatDistance: number;
    sortSplatCoorient: number;
    sortCameraDistance: number;
    sortCameraCoorient: number;
    toneMappingEnabled: boolean;
    toneMapping: ToneMappingValue;
    exposure: number;
    highlightEnabled: boolean;
    highlightSize: number;
    highlightColor: string;
    lodMinLevel: number;
    lodMaxBudget: number;
    lodBackgroundPenalty: number;
    lodOutsidePenalty: number;
    lodBehindPenalty: number;
    lodBehindTolerance: number;
    lodBehindDistanceTolerance: number;
    lodHysteresisTicks: number;
    lodSchedulerParallelCounts: number;
    lodSchedulerExistingTaskLimit: number;
    lodSchedulerMinDuration: number;
}

const DEFAULT_SORT_PARAMS: Pick<
    ViewerParams,
    | 'sortRadial'
    | 'sortMinDuration'
    | 'sortSplatDistance'
    | 'sortSplatCoorient'
    | 'sortCameraDistance'
    | 'sortCameraCoorient'
> = {
    sortRadial: true,
    sortMinDuration: 0,
    sortSplatDistance: 0.1,
    sortSplatCoorient: 0.99999,
    sortCameraDistance: 1,
    sortCameraCoorient: 0.99,
};

const EXTREME_PERFORMANCE_SORT_PARAMS: typeof DEFAULT_SORT_PARAMS = {
    ...DEFAULT_SORT_PARAMS,
    sortMinDuration: 160,
    sortSplatCoorient: 0.999999,
};

const VIEWER_SPLATTING_PRESETS: Record<SplattingPresetId, { params: Partial<ViewerParams> }> = {
    custom: {
        params: {},
    },
    maxQuality: {
        params: {
            ...DEFAULT_SORT_PARAMS,
            splatPackType: SplatPackType.Compressed,
            maxSh: 3,
            maxStdDev: 8,
            packHighPrecisionEnabled: true,
            precalculateEnabled: true,
            repackEnabled: false,
            renderAttachHighPrecisionEnabled: true,
            normalizedFalloff: true,
            preBlurAmount: 0.3,
            blurAmount: 0,
            focalAdjustment: 2,
            detailCullingThreshold: 0,
            maxPixelRadius: 1024,
        },
    },
    qualityFirst: {
        params: {
            ...DEFAULT_SORT_PARAMS,
            splatPackType: SplatPackType.Compressed,
            maxSh: 3,
            maxStdDev: 8,
            packHighPrecisionEnabled: true,
            precalculateEnabled: true,
            repackEnabled: false,
            renderAttachHighPrecisionEnabled: false,
            normalizedFalloff: false,
            preBlurAmount: 0.3,
            blurAmount: 0,
            focalAdjustment: 2,
            detailCullingThreshold: 1,
            maxPixelRadius: 1024,
        },
    },
    performanceFirst: {
        params: {
            ...DEFAULT_SORT_PARAMS,
            splatPackType: SplatPackType.SuperCompressed,
            maxSh: 3,
            maxStdDev: 5,
            packHighPrecisionEnabled: false,
            precalculateEnabled: true,
            repackEnabled: false,
            renderAttachHighPrecisionEnabled: false,
            normalizedFalloff: false,
            preBlurAmount: 0.3,
            blurAmount: 0,
            focalAdjustment: 2,
            detailCullingThreshold: 1,
            maxPixelRadius: 1024,
        },
    },
    extremePerformance: {
        params: {
            ...EXTREME_PERFORMANCE_SORT_PARAMS,
            splatPackType: SplatPackType.SuperCompressed,
            maxSh: 3,
            maxStdDev: 5,
            packHighPrecisionEnabled: false,
            precalculateEnabled: true,
            repackEnabled: true,
            renderAttachHighPrecisionEnabled: false,
            normalizedFalloff: false,
            preBlurAmount: 0.3,
            blurAmount: 0,
            focalAdjustment: 2,
            detailCullingThreshold: 4,
            maxPixelRadius: 1024,
        },
    },
};

export async function mountViewerPage(root: HTMLElement, config: ViewerPageConfig) {
    const surface = query<HTMLElement>(root, '[data-render-surface]');
    const stage = query<HTMLElement>(root, '[data-viewer-stage]');
    const status = query<HTMLElement>(root, '[data-status]');
    const leftRail = query<HTMLElement>(root, '[data-left-rail]');
    const leftToggle = query<HTMLButtonElement>(root, '[data-left-toggle]');
    const leftClose = query<HTMLButtonElement>(root, '[data-left-close]');
    const rightRail = query<HTMLElement>(root, '[data-right-rail]');
    const rightToggle = query<HTMLButtonElement>(root, '[data-right-toggle]');
    const rightClose = query<HTMLButtonElement>(root, '[data-right-close]');
    const fileInput = query<HTMLInputElement>(root, '[data-file-input]');
    const urlForm = query<HTMLFormElement>(root, '[data-url-form]');
    const urlInput = query<HTMLTextAreaElement>(root, '[data-url-input]');
    const clipboardLoad = query<HTMLButtonElement>(root, '[data-clipboard-load]');
    const fileList = query<HTMLElement>(root, '[data-file-list]');
    const coordSelect = query<HTMLSelectElement>(root, '[data-camera-coord]');
    const farInput = query<HTMLInputElement>(root, '[data-camera-far]');
    const useOrbitInput = query<HTMLInputElement>(root, '[data-camera-use-orbit]');
    const copyCameraButton = query<HTMLButtonElement>(root, '[data-camera-copy]');
    const pasteCameraButton = query<HTMLButtonElement>(root, '[data-camera-paste]');
    const resetCameraButton = query<HTMLButtonElement>(root, '[data-camera-reset]');
    const configPanel = query<HTMLElement>(root, '[data-config-panel]');
    const fpsStat = query<HTMLElement>(root, '[data-stat-fps]');
    const supportedFileExtensions = getSupportedFileExtensions(fileInput);

    const params = createDefaultParams();
    const viewer = createViewer(`aholo-viewer-page-${Date.now()}`, surface, { antialiasing: false });
    const scene = new Scene3D();
    const camera = new PerspectiveCamera(60, 1, 0.1, Number(farInput.value) || 2000);
    const control = new CameraControl(camera, surface, { enabled: true });

    let disposed = false;
    let rafId: number | undefined;
    let lastFrameTime = 0;
    let renderRequested = true;
    let loadAbortController: AbortController | undefined;
    let leftRailCollapsed = readLeftRailCollapsed();
    let rightRailCollapsed = readRightRailCollapsed();
    let fileDragDepth = 0;
    let keepPrecalculateDisabled = false;
    const lodSplats: LodSplatInstance[] = [];
    const records: FileRecord[] = [];
    const estimateFps = createFpsEstimator();

    configureFileInputForPlatform(fileInput);

    const pane = setupConfigPanel(
        configPanel,
        config.labels,
        params,
        () => keepPrecalculateDisabled,
        () => {
            applyViewerConfig(viewer, params);
            syncLodConfig();
            requestRender();
        },
    );
    const fullscreenMode = mountWorkspaceFullscreenMode({
        onChange() {
            resize();
        },
    });
    const resizeObserver = new ResizeObserver(() => resize());

    syncLeftRail();
    syncRightRail();
    viewer.setScene(scene);
    viewer.setCamera(camera);
    applyViewerConfig(viewer, params);
    applyCoordinateSystem(coordSelect.value);
    resizeObserver.observe(stage);
    resize();
    tick();
    setStatus('ready', config.labels.statusReady);

    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files ?? []);
        if (files.length > 0) {
            void loadSources(files.map(fileToSource));
        }
        fileInput.value = '';
    });
    root.addEventListener('dragenter', handleDragEnter);
    root.addEventListener('dragover', handleDragOver);
    root.addEventListener('dragleave', handleDragLeave);
    root.addEventListener('drop', handleDrop);
    urlForm.addEventListener('submit', event => {
        event.preventDefault();
        const sources = parseUrls(urlInput.value).map(urlToSource);
        if (sources.length > 0) {
            void loadSources(sources);
        }
    });
    clipboardLoad.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            urlInput.value = text;
            const sources = parseUrls(text).map(urlToSource);
            if (sources.length > 0) {
                void loadSources(sources);
            }
        } catch (error) {
            setStatus('error', getErrorMessage(error));
        }
    });
    fileList.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const deleteButton = target.closest<HTMLButtonElement>('[data-file-delete]');
        if (!deleteButton || !fileList.contains(deleteButton)) {
            return;
        }

        clearLoadedScene();
    });
    coordSelect.addEventListener('change', () => {
        applyCoordinateSystem(coordSelect.value);
        requestRender();
    });
    farInput.addEventListener('change', () => {
        const far = Number(farInput.value);
        if (Number.isFinite(far) && far > camera.near) {
            camera.far = far;
            camera.updateProjectionMatrix();
            requestRender();
        }
    });
    useOrbitInput.addEventListener('change', () => {
        control.setOptions({ useOrbit: useOrbitInput.checked });
        requestRender();
    });
    copyCameraButton.addEventListener('click', () => {
        void navigator.clipboard.writeText(JSON.stringify(serializeCamera(camera)));
    });
    pasteCameraButton.addEventListener('click', async () => {
        try {
            applyCameraState(camera, JSON.parse(await navigator.clipboard.readText()));
            farInput.value = String(camera.far);
            requestRender();
        } catch (error) {
            setStatus('error', getErrorMessage(error));
        }
    });
    resetCameraButton.addEventListener('click', () => {
        applyCoordinateSystem(coordSelect.value);
        requestRender();
    });
    window.addEventListener('resize', resize);
    window.addEventListener('beforeunload', dispose, { once: true });
    document.addEventListener('astro:before-swap', dispose, { once: true });
    leftToggle.addEventListener('click', handleLeftExpandClick);
    leftClose.addEventListener('click', handleLeftCloseClick);
    rightToggle.addEventListener('click', handleRightExpandClick);
    rightClose.addEventListener('click', handleRightCloseClick);

    function handleLeftExpandClick() {
        setLeftRailCollapsed(false);
    }

    function handleLeftCloseClick() {
        setLeftRailCollapsed(true);
    }

    function handleRightExpandClick() {
        setRightRailCollapsed(false);
    }

    function handleRightCloseClick() {
        setRightRailCollapsed(true);
    }

    function setLeftRailCollapsed(nextCollapsed: boolean) {
        leftRailCollapsed = nextCollapsed;
        writeLeftRailCollapsed(nextCollapsed);
        syncLeftRail();
        resize();
    }

    function setRightRailCollapsed(nextCollapsed: boolean) {
        rightRailCollapsed = nextCollapsed;
        writeRightRailCollapsed(nextCollapsed);
        syncRightRail();
        resize();
    }

    function syncLeftRail() {
        root.dataset.leftCollapsed = String(leftRailCollapsed);
        document.documentElement.dataset.viewerLeftCollapsed = String(leftRailCollapsed);
        leftRail.setAttribute('aria-hidden', String(leftRailCollapsed));
        leftRail.toggleAttribute('inert', leftRailCollapsed);
        leftToggle.setAttribute('aria-expanded', String(!leftRailCollapsed));
        const label = leftToggle.dataset.expandLabel;
        if (label) {
            leftToggle.setAttribute('aria-label', label);
            leftToggle.title = label;
        }
    }

    function syncRightRail() {
        root.dataset.rightCollapsed = String(rightRailCollapsed);
        document.documentElement.dataset.viewerRightCollapsed = String(rightRailCollapsed);
        rightRail.setAttribute('aria-hidden', String(rightRailCollapsed));
        rightRail.toggleAttribute('inert', rightRailCollapsed);
        rightToggle.setAttribute('aria-expanded', String(!rightRailCollapsed));
        const label = rightToggle.dataset.expandLabel;
        if (label) {
            rightToggle.setAttribute('aria-label', label);
            rightToggle.title = label;
        }
    }

    async function loadSources(sources: Source[]) {
        const abortController = new AbortController();
        loadAbortController?.abort();
        loadAbortController = abortController;
        clearScene();
        keepPrecalculateDisabled = false;
        records.length = 0;
        records.push(...sources.map(createFileRecord));
        renderRecords();
        setStatus('loading', config.labels.statusLoading);

        let loaded = 0;
        for (let index = 0; index < sources.length; index++) {
            const source = sources[index];
            const record = records[index];
            if (!record) {
                continue;
            }

            try {
                validateImportSource(source, supportedFileExtensions, config.labels.unsupportedFileType);
                await loadSource(source, record, abortController.signal);
                if (abortController.signal.aborted) {
                    return;
                }
                record.status = 'ready';
                loaded++;
            } catch (error) {
                if (abortController.signal.aborted) {
                    return;
                }
                record.status = 'error';
                record.error = getErrorMessage(error);
            }
            renderRecords();
            requestRender();
        }

        if (loadAbortController === abortController) {
            loadAbortController = undefined;
        }

        setStatus(loaded > 0 ? 'ready' : 'error', loaded > 0 ? config.labels.statusReady : config.labels.statusError);
        requestRender();
    }

    function clearLoadedScene() {
        loadAbortController?.abort();
        clearScene();
        keepPrecalculateDisabled = false;
        records.length = 0;
        renderRecords();
        setStatus('ready', config.labels.statusReady);
        requestRender();
    }

    async function loadSource(source: Source, record: FileRecord, signal: AbortSignal) {
        throwIfAborted(signal);
        const json = await readJsonIfNeeded(source, signal);

        if (json && isLodMeta(json)) {
            record.format = 'LOD JSON';
            await loadLodMeta(json, source.kind === 'url' ? source.url : undefined, signal);
            return;
        }

        const probe = await getDetectionProbe(source, json);
        const type = detectSplatFileType(source.name, probe);

        if (type === undefined) {
            throw new Error(`Unsupported file type: ${source.name}`);
        }

        record.format = getFileTypeLabel(type);
        const data = await parseSourceData(source, type, signal);
        applyImportedSplatDefaults(data);
        const splat = await abortable(createSplat(data), signal);
        scene.add(splat as Object3D);
    }

    async function parseSourceData(source: Source, type: SplatFileTypeValue, signal: AbortSignal) {
        const input = source.kind === 'url' ? source.url : source.file;
        return abortable(
            parseSplatData(type, input, params.splatPackType, {
                maxShDegree: params.maxSh,
                maxTextureSize: 8192,
            }),
            signal,
        );
    }

    function applyImportedSplatDefaults(data: { readonly shDegree: number }) {
        if (data.shDegree !== 0) {
            return;
        }

        keepPrecalculateDisabled = true;
        params.precalculateEnabled = false;
        pane.refreshProgrammatic();
        applyViewerConfig(viewer, params);
        requestRender();
    }

    async function loadLodMeta(meta: LodMeta, baseUrl: string | undefined, signal: AbortSignal) {
        let rejectResourceError: (error: unknown) => void = () => {};
        const resourceError = new Promise<never>((_resolve, reject) => {
            rejectResourceError = reject;
        });
        resourceError.catch(() => {});

        const lodSplat = new LodSplat(
            meta,
            {
                ...getLodConfig(params),
                minLevel: getInitialLodLevel(meta, params),
                schedulerParallelCounts: 99999,
                schedulerExistingTaskLimit: 99999,
                schedulerMinDuration: 0,
            },
            createViewerContext(viewer),
            async (url: string) => {
                try {
                    return await loadLodResource(url, baseUrl, signal);
                } catch (error) {
                    rejectResourceError(error);
                    throw error;
                }
            },
        );

        lodSplats.push(lodSplat);
        scene.add(lodSplat.container);
        lodSplat.tick(camera);
        lodSplat.start();
        requestRender();

        await Promise.race([abortable(lodSplat.onFinishSchedule(), signal), resourceError]);
        throwIfAborted(signal);
        lodSplat.setConfig(getLodConfig(params));
        lodSplat.tick(camera);
    }

    async function loadLodResource(url: string, baseUrl: string | undefined, signal: AbortSignal) {
        throwIfAborted(signal);
        const resourceUrl = resolveResourceUrl(url, baseUrl);
        const type = detectSplatFileType(resourceUrl, new Uint8Array());

        if (type === undefined) {
            throw new Error(`Unsupported LOD resource: ${resourceUrl}`);
        }

        const data = await abortable(parseSplatData(type, resourceUrl, SplatPackType.Compressed), signal);
        applyImportedSplatDefaults(data);
        return data;
    }

    function clearScene() {
        for (const lodSplat of lodSplats.splice(0)) {
            lodSplat.destroy();
        }

        for (const child of scene.removeAllChildren()) {
            disposeSceneObject(child);
        }
        scene.notifySceneChange();
    }

    function syncLodConfig() {
        const lodConfig = getLodConfig(params);
        for (const lodSplat of lodSplats) {
            lodSplat.setConfig(lodConfig);
            lodSplat.tick(camera);
        }
    }

    function resize() {
        viewer.resize();
        syncCameraAspect(camera, viewer);
        requestRender();
    }

    function requestRender() {
        renderRequested = true;
    }

    function tick(time = performance.now()) {
        if (disposed) {
            return;
        }

        const delta = lastFrameTime > 0 ? Math.min((time - lastFrameTime) / 1000, 0.1) : 0;
        lastFrameTime = time;
        const controlUpdated = control.update(delta);
        let lodUpdated = false;

        for (const lodSplat of lodSplats) {
            lodSplat.tick(camera);
            lodUpdated = true;
        }

        if (renderRequested || controlUpdated || lodUpdated) {
            syncCameraAspect(camera, viewer);
            scene.notifySceneChange();
        }

        renderRequested = false;
        viewer.render();
        updateStats();
        rafId = window.requestAnimationFrame(tick);
    }

    function updateStats() {
        fpsStat.textContent = estimateFps().toString();
    }

    function applyCoordinateSystem(value: string) {
        switch (value) {
            case 'aholo':
                camera.up.set(0, 0, 1);
                camera.position.set(0, -3, 1.2);
                break;
            case 'opengl':
                camera.up.set(0, 1, 0);
                camera.position.set(0, 1.2, 3);
                break;
            case 'opencv':
            default:
                camera.up.set(0, -1, 0);
                camera.position.set(0, -1.2, 3);
                break;
        }

        camera.lookAt(new Vector3(0, 0, 0));
        camera.far = Number(farInput.value) || 2000;
        camera.updateProjectionMatrix();
        control.stop();
    }

    function setStatus(state: 'loading' | 'ready' | 'error', message: string) {
        status.dataset.state = state;
        status.textContent = state === 'error' ? message : '';
    }

    function handleDragEnter(event: DragEvent) {
        if (!isFileDrag(event)) {
            return;
        }

        event.preventDefault();
        fileDragDepth++;
        setDropActive(true);
    }

    function handleDragOver(event: DragEvent) {
        if (!isFileDrag(event)) {
            return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        setDropActive(true);
    }

    function handleDragLeave(event: DragEvent) {
        if (!isFileDrag(event)) {
            return;
        }

        event.preventDefault();
        fileDragDepth = Math.max(0, fileDragDepth - 1);

        if (fileDragDepth === 0) {
            setDropActive(false);
        }
    }

    function handleDrop(event: DragEvent) {
        const files = Array.from(event.dataTransfer?.files ?? []);

        if (files.length === 0) {
            return;
        }

        event.preventDefault();
        fileDragDepth = 0;
        setDropActive(false);

        if (files.length > 0) {
            void loadSources(files.map(fileToSource));
        }
    }

    function setDropActive(active: boolean) {
        root.dataset.fileDragging = String(active);
    }

    function renderRecords() {
        renderFileList(fileList, records, config);
    }

    function isFileDrag(event: DragEvent) {
        return Array.from(event.dataTransfer?.types ?? []).includes('Files');
    }

    function dispose() {
        if (disposed) {
            return;
        }

        disposed = true;
        loadAbortController?.abort();
        resizeObserver.disconnect();
        root.removeEventListener('dragenter', handleDragEnter);
        root.removeEventListener('dragover', handleDragOver);
        root.removeEventListener('dragleave', handleDragLeave);
        root.removeEventListener('drop', handleDrop);
        window.removeEventListener('resize', resize);
        leftToggle.removeEventListener('click', handleLeftExpandClick);
        leftClose.removeEventListener('click', handleLeftCloseClick);
        rightToggle.removeEventListener('click', handleRightExpandClick);
        rightClose.removeEventListener('click', handleRightCloseClick);
        if (rafId !== undefined) {
            window.cancelAnimationFrame(rafId);
        }
        control.dispose();
        clearScene();
        fullscreenMode.dispose();
        pane.dispose();
        viewer.destroy();
    }

    renderRecords();
}

function createDefaultParams(): ViewerParams {
    return {
        splattingPreset: 'performanceFirst',
        pixelRatio: 1,
        splatPackType: SplatPackType.SuperCompressed,
        maxSh: 3,
        maxStdDev: 5,
        packHighPrecisionEnabled: false,
        precalculateEnabled: true,
        repackEnabled: false,
        renderAttachHighPrecisionEnabled: false,
        normalizedFalloff: false,
        preBlurAmount: 0.3,
        blurAmount: 0,
        focalAdjustment: 2,
        detailCullingThreshold: 1,
        maxPixelRadius: 1024,
        sortRadial: true,
        sortMinDuration: 0,
        sortSplatDistance: 0.1,
        sortSplatCoorient: 0.99999,
        sortCameraDistance: 1,
        sortCameraCoorient: 0.99,
        toneMappingEnabled: false,
        toneMapping: ToneMapping.Linear,
        exposure: 1,
        highlightEnabled: false,
        highlightSize: 2,
        highlightColor: '#0000ff',
        lodMinLevel: 0,
        lodMaxBudget: 3_000_000,
        lodBackgroundPenalty: 0.5,
        lodOutsidePenalty: 0.4,
        lodBehindPenalty: 0.1,
        lodBehindTolerance: -0.2,
        lodBehindDistanceTolerance: 2,
        lodHysteresisTicks: 4,
        lodSchedulerParallelCounts: 4,
        lodSchedulerExistingTaskLimit: 64,
        lodSchedulerMinDuration: 160,
    };
}

function applySplattingPreset(
    params: ViewerParams,
    preset: SplattingPresetId,
    options: { keepPrecalculateDisabled: boolean },
) {
    Object.assign(params, VIEWER_SPLATTING_PRESETS[preset].params, {
        splattingPreset: preset,
    });

    if (options.keepPrecalculateDisabled) {
        params.precalculateEnabled = false;
    }
}

function createSplattingPresetOptions(labels: ViewerLabels) {
    return {
        [labels.presetCustom]: 'custom',
        [labels.presetMaxQuality]: 'maxQuality',
        [labels.presetQualityFirst]: 'qualityFirst',
        [labels.presetPerformanceFirst]: 'performanceFirst',
        [labels.presetExtremePerformance]: 'extremePerformance',
    } satisfies Record<string, SplattingPresetId>;
}

function setupConfigPanel(
    container: HTMLElement,
    labels: ViewerLabels,
    params: ViewerParams,
    shouldKeepPrecalculateDisabled: () => boolean,
    onChange: () => void,
) {
    const pane = new Pane({
        container,
        expanded: true,
        title: labels.settings,
    });
    const presetBinding = pane.addBinding(params, 'splattingPreset', {
        label: labels.preset,
        options: createSplattingPresetOptions(labels),
    });
    addViewerConfigTip(presetBinding, labels.presetPackTypeTip);
    let isApplyingSplattingPreset = false;
    const refreshProgrammatic = () => {
        isApplyingSplattingPreset = true;
        pane.refresh();
        queueMicrotask(() => {
            isApplyingSplattingPreset = false;
        });
    };
    presetBinding.on('change', event => {
        isApplyingSplattingPreset = true;
        applySplattingPreset(params, event.value, { keepPrecalculateDisabled: shouldKeepPrecalculateDisabled() });
        pane.refresh();
        onChange();
        queueMicrotask(() => {
            isApplyingSplattingPreset = false;
        });
    });
    const pixelRatioBinding = pane.addBinding(params, 'pixelRatio', {
        label: 'Pixel Ratio',
        max: Math.max(2, window.devicePixelRatio),
        min: 0.5,
        step: 0.1,
    });
    pixelRatioBinding.on('change', onChange);
    const markCustomPreset = () => {
        if (isApplyingSplattingPreset || params.splattingPreset === 'custom') {
            return;
        }

        params.splattingPreset = 'custom';
        presetBinding.refresh();
    };
    const handleSplattingParamChange = () => {
        markCustomPreset();
        onChange();
    };

    const splatting = pane.addFolder({ title: 'Splatting', expanded: false });
    const packTypeBinding = splatting
        .addBinding(params, 'splatPackType', {
            label: 'Pack type',
            options: {
                compressed: SplatPackType.Compressed,
                superCompressed: SplatPackType.SuperCompressed,
                sog: SplatPackType.Sog,
            },
        })
        .on('change', markCustomPreset);
    addViewerConfigTip(packTypeBinding, labels.packTypeTip);
    splatting
        .addBinding(params, 'packHighPrecisionEnabled', { label: 'High precision pack' })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'precalculateEnabled', { label: 'Precalculate SH' })
        .on('change', handleSplattingParamChange);
    splatting.addBinding(params, 'repackEnabled', { label: 'Repack' }).on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'renderAttachHighPrecisionEnabled', { label: 'High precision attach' })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'maxSh', { label: 'Max SH', min: 0, max: 3, step: 1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'normalizedFalloff', { label: 'Normalized falloff' })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'preBlurAmount', { label: 'Pre blur', min: 0, max: 1, step: 0.1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'blurAmount', { label: 'Blur', min: 0, max: 1, step: 0.1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'focalAdjustment', { label: 'Focal adjustment', min: 0.5, max: 2, step: 0.1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'detailCullingThreshold', { label: 'Detail culling', min: 0, max: 8, step: 1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'maxPixelRadius', { label: 'Max pixel radius', min: 1, max: 1024, step: 1 })
        .on('change', handleSplattingParamChange);
    splatting
        .addBinding(params, 'maxStdDev', { label: 'Max std dev', min: 5, max: 8, step: 1 })
        .on('change', handleSplattingParamChange);

    const sort = pane.addFolder({ title: 'Sort', expanded: false });
    sort.addBinding(params, 'sortRadial', { label: 'Radial' }).on('change', handleSplattingParamChange);
    sort.addBinding(params, 'sortMinDuration', { label: 'Min duration', min: 0, max: 160, step: 16 }).on(
        'change',
        handleSplattingParamChange,
    );
    sort.addBinding(params, 'sortSplatDistance', { label: 'Splat distance', min: 0, max: 1, step: 0.01 }).on(
        'change',
        handleSplattingParamChange,
    );
    sort.addBinding(params, 'sortSplatCoorient', { label: 'Splat coorient', min: 0, max: 1, step: 0.01 }).on(
        'change',
        handleSplattingParamChange,
    );
    sort.addBinding(params, 'sortCameraDistance', { label: 'Camera distance', min: 0, max: 1, step: 0.01 }).on(
        'change',
        handleSplattingParamChange,
    );
    sort.addBinding(params, 'sortCameraCoorient', { label: 'Camera coorient', min: 0, max: 1, step: 0.01 }).on(
        'change',
        handleSplattingParamChange,
    );

    const toneMapping = pane.addFolder({ title: 'Tone Mapping', expanded: false });
    toneMapping.addBinding(params, 'toneMappingEnabled', { label: 'Enabled' }).on('change', onChange);
    toneMapping
        .addBinding(params, 'toneMapping', {
            label: 'Curve',
            options: {
                Linear: ToneMapping.Linear,
                Reinhard: ToneMapping.Reinhard,
                ACES: ToneMapping.ACES,
                ACESFilmic: ToneMapping.ACESFilmic,
                Neutral: ToneMapping.Neutral,
            },
        })
        .on('change', onChange);
    toneMapping
        .addBinding(params, 'exposure', { label: 'Exposure', min: 0.1, max: 4, step: 0.1 })
        .on('change', onChange);

    const highlight = pane.addFolder({ title: 'Highlight Kernel', expanded: false });
    highlight.addBinding(params, 'highlightEnabled', { label: 'Enabled' }).on('change', onChange);
    highlight.addBinding(params, 'highlightSize', { label: 'Size', min: 1, max: 10, step: 1 }).on('change', onChange);
    highlight.addBinding(params, 'highlightColor', { label: 'Color' }).on('change', onChange);

    const lod = pane.addFolder({ title: 'LOD Config', expanded: false });
    lod.addBinding(params, 'lodMinLevel', { label: 'Min level', min: 0, max: 4, step: 1 }).on('change', onChange);
    lod.addBinding(params, 'lodMaxBudget', { label: 'Max budget', min: 1_000_000, max: 40_000_000, step: 100_000 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodBackgroundPenalty', { label: 'Background penalty', min: 0, max: 1, step: 0.1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodOutsidePenalty', { label: 'Outside penalty', min: 0, max: 1, step: 0.1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodBehindPenalty', { label: 'Behind penalty', min: 0, max: 1, step: 0.1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodBehindTolerance', { label: 'Behind tolerance', min: -1, max: 1, step: 0.1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodBehindDistanceTolerance', { label: 'Behind distance', min: 0, max: 10, step: 1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodHysteresisTicks', { label: 'Hysteresis', min: 1, max: 10, step: 1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodSchedulerParallelCounts', { label: 'Parallel', min: 1, max: 16, step: 1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodSchedulerExistingTaskLimit', { label: 'Task limit', min: 1, max: 128, step: 1 }).on(
        'change',
        onChange,
    );
    lod.addBinding(params, 'lodSchedulerMinDuration', { label: 'Min duration', min: 16, max: 1600, step: 16 }).on(
        'change',
        onChange,
    );

    return {
        dispose() {
            pane.dispose();
        },
        refreshProgrammatic,
    };
}

function addViewerConfigTip(target: { element: HTMLElement }, text: string) {
    target.element.title = text;
}

function applyViewerConfig(viewer: Viewer, params: ViewerParams) {
    setViewerConfig(viewer, {
        pixelRatio: params.pixelRatio / window.devicePixelRatio,
        pipeline: {
            Background: {
                background: {
                    active: BackgroundMode.BasicBackground,
                    basic: { color: new Color(0, 0, 0), alpha: 1 },
                },
                ground: { enabled: false },
            },
            Splatting: {
                enabled: true,
                packHighPrecisionEnabled: params.packHighPrecisionEnabled,
                precalculateEnabled: params.precalculateEnabled,
                repackEnabled: params.repackEnabled,
                normalizedFalloff: params.normalizedFalloff,
                preBlurAmount: params.preBlurAmount,
                blurAmount: params.blurAmount,
                focalAdjustment: params.focalAdjustment,
                detailCullingThreshold: params.detailCullingThreshold,
                maxPixelRadius: params.maxPixelRadius,
                maxStdDev: globalThis.Math.sqrt(params.maxStdDev),
                sort: {
                    sortRadial: params.sortRadial,
                    sortMinDuration: params.sortMinDuration,
                    sortSplatDistance: params.sortSplatDistance,
                    sortSplatCoorient: params.sortSplatCoorient,
                    sortCameraDistance: params.sortCameraDistance,
                    sortCameraCoorient: params.sortCameraCoorient,
                },
                composite: {
                    enabled: params.renderAttachHighPrecisionEnabled,
                    highPrecisionAttachEnabled: params.renderAttachHighPrecisionEnabled,
                },
                toneMapping: {
                    enabled: params.toneMappingEnabled,
                    toneMapping: params.toneMapping,
                    exposure: params.exposure,
                },
                highlightKernel: {
                    enabled: params.highlightEnabled,
                    size: params.highlightSize,
                    color: colorToNumber(params.highlightColor),
                },
            },
            TAA: { enabled: false },
        },
    });
}

function getLodConfig(params: ViewerParams) {
    return {
        minLevel: params.lodMinLevel,
        maxBudget: params.lodMaxBudget,
        backgroundPenalty: params.lodBackgroundPenalty,
        outsidePenalty: params.lodOutsidePenalty,
        behindPenalty: params.lodBehindPenalty,
        behindTolerance: params.lodBehindTolerance,
        behindDistanceTolerance: params.lodBehindDistanceTolerance,
        hysteresisTicks: params.lodHysteresisTicks,
        schedulerParallelCounts: params.lodSchedulerParallelCounts,
        schedulerExistingTaskLimit: params.lodSchedulerExistingTaskLimit,
        schedulerMinDuration: params.lodSchedulerMinDuration,
    };
}

function getInitialLodLevel(meta: LodMeta, params: ViewerParams) {
    const levels = typeof meta.levels === 'number' ? meta.levels : 1;
    return globalThis.Math.min(globalThis.Math.max(0, levels - 1), globalThis.Math.max(4, params.lodMinLevel));
}

function isLodMeta(value: unknown): value is LodMeta {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const meta = value as Record<string, unknown>;
    return (
        meta.magicCode === LOD_MAGIC_CODE &&
        meta.type === 'lod-splat' &&
        typeof meta.counts === 'number' &&
        typeof meta.levels === 'number' &&
        Array.isArray(meta.files)
    );
}

async function readJsonIfNeeded(source: Source, signal: AbortSignal) {
    if (!source.name.toLowerCase().endsWith('.json')) {
        return undefined;
    }

    const text =
        source.kind === 'url'
            ? await abortable(fetchText(source.url, signal), signal)
            : await abortable(source.file.text(), signal);

    return JSON.parse(text) as unknown;
}

async function fetchText(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response.text();
}

async function getDetectionProbe(source: Source, json: unknown) {
    if (json !== undefined) {
        return new TextEncoder().encode(JSON.stringify(json));
    }

    if (source.kind === 'file') {
        return new Uint8Array(await source.file.slice(0, 4096).arrayBuffer());
    }

    return new Uint8Array();
}

function renderFileList(container: HTMLElement, records: FileRecord[], config: ViewerPageConfig) {
    container.replaceChildren();

    if (records.length === 0) {
        const item = document.createElement('li');
        item.className = 'viewer-empty-file';
        item.textContent = config.labels.emptyFiles;
        container.append(item);
        return;
    }

    for (const record of records) {
        const item = document.createElement('li');
        item.className = 'viewer-file-item';
        item.dataset.state = record.status;

        const header = document.createElement('div');
        header.className = 'viewer-file-item-header';

        const info = document.createElement('div');
        info.className = 'viewer-file-info';

        const title = document.createElement('strong');
        title.textContent = record.name;

        const details = document.createElement('span');
        details.textContent = `${record.format} / ${record.size}`;
        info.append(title, details);

        const state = document.createElement('span');
        state.className = 'viewer-file-state';
        state.dataset.state = record.status;
        state.setAttribute('aria-label', record.error ?? record.status);
        state.title = record.error ?? record.status;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'viewer-file-delete';
        deleteButton.dataset.fileDelete = '';
        deleteButton.setAttribute('aria-label', `${config.labels.removeFile}: ${record.name}`);
        deleteButton.title = config.labels.removeFile;

        const deleteIcon = createTrashIcon();
        deleteButton.append(deleteIcon);
        header.append(info, state, deleteButton);

        item.append(header);
        container.append(item);
    }
}

function readLeftRailCollapsed() {
    return readRailCollapsed(LEFT_RAIL_COLLAPSED_STORAGE_KEY);
}

function readRightRailCollapsed() {
    return readRailCollapsed(RIGHT_RAIL_COLLAPSED_STORAGE_KEY);
}

function readRailCollapsed(storageKey: string) {
    if (isCompactViewerLayout()) {
        return true;
    }

    try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) {
            return stored === 'true';
        }
    } catch {
        // Fall through to the responsive default when storage is unavailable.
    }

    return false;
}

function createTrashIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('class', 'viewer-delete-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');

    for (const attributes of [
        { d: 'M3 6h18' },
        { d: 'M8 6V4h8v2' },
        { d: 'M6 6l1 15h10l1-15' },
        { d: 'M10 11v6' },
        { d: 'M14 11v6' },
    ]) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', attributes.d);
        icon.append(path);
    }

    return icon;
}

function writeLeftRailCollapsed(collapsed: boolean) {
    writeRailCollapsed(LEFT_RAIL_COLLAPSED_STORAGE_KEY, collapsed);
}

function writeRightRailCollapsed(collapsed: boolean) {
    writeRailCollapsed(RIGHT_RAIL_COLLAPSED_STORAGE_KEY, collapsed);
}

function writeRailCollapsed(storageKey: string, collapsed: boolean) {
    try {
        localStorage.setItem(storageKey, String(collapsed));
    } catch {
        // Persisting the panel state is optional; the viewer should still run.
    }
}

function isCompactViewerLayout() {
    return window.matchMedia('(max-width: 720px)').matches;
}

function createFileRecord(source: Source): FileRecord {
    return {
        name: source.name,
        format: getInitialFormat(source.name),
        size: source.size === undefined ? '-' : formatBytes(source.size),
        status: 'loading',
    };
}

function fileToSource(file: File): Source {
    return {
        kind: 'file',
        file,
        name: file.name,
        size: file.size,
    };
}

function urlToSource(url: string): Source {
    return {
        kind: 'url',
        url,
        name: getUrlFileName(url),
    };
}

function parseUrls(value: string) {
    return value
        .split(/[\s,]+/u)
        .map(item => item.trim())
        .filter(Boolean);
}

function configureFileInputForPlatform(fileInput: HTMLInputElement) {
    if (isIosFilePicker()) {
        fileInput.removeAttribute('accept');
    }
}

function isIosFilePicker() {
    const userAgent = navigator.userAgent;

    return /iP(?:ad|hone|od)/u.test(userAgent) || (/Macintosh/u.test(userAgent) && navigator.maxTouchPoints > 1);
}

function getSupportedFileExtensions(fileInput: HTMLInputElement) {
    const extensions = fileInput.accept
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(item => item.startsWith('.'));

    return extensions.length > 0 ? extensions : [...SUPPORTED_FILE_EXTENSIONS];
}

function validateImportSource(source: Source, supportedExtensions: readonly string[], unsupportedLabel: string) {
    if (supportedExtensions.includes(getSourceExtension(source))) {
        return;
    }

    throw new Error(`${unsupportedLabel}: ${source.name} (${supportedExtensions.join(', ')})`);
}

function getSourceExtension(source: Source) {
    const name = source.name.trim().toLowerCase();
    const queryIndex = name.search(/[?#]/u);
    const filename = queryIndex === -1 ? name : name.slice(0, queryIndex);
    const extensionIndex = filename.lastIndexOf('.');

    return extensionIndex === -1 ? '' : filename.slice(extensionIndex);
}

function getUrlFileName(url: string) {
    try {
        const parsed = new URL(url);
        const pathname = decodeURIComponent(parsed.pathname);
        return pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    } catch {
        return url;
    }
}

function getInitialFormat(name: string) {
    const extension = name.split('.').pop();
    return extension ? extension.toUpperCase() : 'Unknown';
}

function getFileTypeLabel(type: SplatFileTypeValue) {
    switch (type) {
        case SplatFileType.PLY:
            return 'PLY';
        case SplatFileType.SPZ:
            return 'SPZ';
        case SplatFileType.SPLAT:
            return 'SPLAT';
        case SplatFileType.KSPLAT:
            return 'KSPLAT';
        case SplatFileType.LCC:
            return 'LCC';
        case SplatFileType.SOG:
            return 'SOG';
        case SplatFileType.ESZ:
            return 'ESZ';
        default:
            return 'Unknown';
    }
}

function formatBytes(bytes: number) {
    if (bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = globalThis.Math.min(
        globalThis.Math.floor(globalThis.Math.log(bytes) / globalThis.Math.log(1024)),
        units.length - 1,
    );
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function colorToNumber(value: string) {
    return Number.parseInt(value.replace(/^#/u, ''), 16);
}

function resolveResourceUrl(url: string, baseUrl: string | undefined) {
    try {
        return new URL(url, baseUrl ?? window.location.href).toString();
    } catch {
        return url;
    }
}

function serializeCamera(camera: PerspectiveCamera) {
    return {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        rotation: { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z, order: camera.rotation.order },
        up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
    };
}

function applyCameraState(camera: PerspectiveCamera, state: unknown) {
    if (!state || typeof state !== 'object') {
        throw new Error('Invalid camera state.');
    }

    const value = state as ReturnType<typeof serializeCamera>;
    camera.position.set(value.position.x, value.position.y, value.position.z);
    camera.rotation.order = value.rotation.order;
    camera.rotation.set(value.rotation.x, value.rotation.y, value.rotation.z);
    camera.up.set(value.up.x, value.up.y, value.up.z);
    camera.fov = value.fov;
    camera.near = value.near;
    camera.far = value.far;
    camera.updateProjectionMatrix();
}

function disposeSceneObject(object: Object3D | SplatObject) {
    const disposable = object as Object3D & {
        destroy?: () => void;
        freeGPU?: () => void;
    };

    disposable.freeGPU?.();
    disposable.destroy?.();
}

function createFpsEstimator() {
    let lastFrameTime = 0;
    let lastDisplayTime = 0;
    let smoothedFps = 0;
    let displayedFps = 0;

    return () => {
        const now = performance.now();

        if (lastFrameTime === 0) {
            lastFrameTime = now;
            lastDisplayTime = now;
            return displayedFps;
        }

        const frameDelta = globalThis.Math.max(1, now - lastFrameTime);
        const fps = 1000 / frameDelta;
        lastFrameTime = now;
        smoothedFps = smoothedFps === 0 ? fps : smoothedFps + (fps - smoothedFps) * FPS_SMOOTHING_FACTOR;

        if (now - lastDisplayTime >= FPS_DISPLAY_INTERVAL_MS) {
            displayedFps = globalThis.Math.round(smoothedFps);
            lastDisplayTime = now;
        }

        return displayedFps;
    };
}

function throwIfAborted(signal: AbortSignal) {
    throwIfAbortedWithMessage(signal, VIEWER_ABORT_MESSAGE);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
    return abortableWithMessage(promise, signal, VIEWER_ABORT_MESSAGE);
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function query<T extends Element>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);

    if (!element) {
        throw new Error(`Missing viewer element: ${selector}`);
    }

    return element;
}
