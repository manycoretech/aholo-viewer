import {
    BackgroundMode,
    Color,
    SplatLoader,
    SplatUtils,
    ToneMapping,
    setViewerConfig,
    type Viewer,
} from '@manycore/aholo-viewer';
import { Pane, type BindingParams, type FolderApi } from 'tweakpane';
import type { ViewerLabels } from './viewer-labels.js';
const { SplatPackType } = SplatLoader;
const VIEWER_SETTINGS_VERSION = 'v1';

type SplatPackTypeValue = (typeof SplatPackType)[keyof typeof SplatPackType];
type ToneMappingValue = (typeof ToneMapping)[keyof typeof ToneMapping];
type SplattingPresetId =
    | 'custom'
    | 'maxQuality'
    | 'qualityFirst'
    | 'balanced'
    | 'performanceFirst'
    | 'extremePerformance';
export interface ViewerParams {
    splattingPreset: SplattingPresetId;
    pixelRatio: number;
    splatPackType: SplatPackTypeValue;
    maxSh: number;
    maxStdDev: number;
    packHighPrecisionEnabled: boolean;
    precalculateEnabled: boolean;
    repackEnabled: boolean;
    radial: boolean;
    cameraRelativeEnabled: boolean;
    autoFreeResourceOnGpuPacked: boolean;
    renderAttachHighPrecisionEnabled: boolean;
    detailCullingAlphaEnabled: boolean;
    preBlurAmount: number;
    blurAmount: number;
    focalAdjustment: number;
    detailCullingThreshold: number;
    maxPixelRadius: number;
    minIntervalMs: number;
    sortSplatDistance: number;
    sortSplatCoorient: number;
    sortCameraDistance: number;
    sortCameraCoorient: number;
    compositeEnabled: boolean;
    toneMapping: ToneMappingValue;
    exposure: number;
    highlightEnabled: boolean;
    highlightSize: number;
    highlightColor: string;
    lodMinLevel: number;
    lodMovingMinLevel: number;
    lodMaxBudget: number;
    lodPixelLimitEnabled: boolean;
    lodFrustumCullingEnabled: boolean;
    lodHysteresisTicks: number;
    lodSchedulerParallelCounts: number;
    lodSchedulerExistingTaskLimit: number;
    lodSchedulerMinDuration: number;
}

const VIEWER_SHARED_DEFAULTS = {
    pixelRatio: 1,
    repackEnabled: true,
    preBlurAmount: 0.3,
    blurAmount: 0,
    focalAdjustment: 2,
    maxPixelRadius: 1024,
    radial: false,
    sortSplatDistance: 0.1,
    sortSplatCoorient: 0.99999,
    sortCameraDistance: 1,
    sortCameraCoorient: 0.99,
    toneMapping: ToneMapping.Linear,
    exposure: 1,
    highlightEnabled: false,
    highlightSize: 2,
    highlightColor: '#0000ff',
    lodMinLevel: 0,
    lodMovingMinLevel: 2,
    lodMaxBudget: 6_000_000,
    lodPixelLimitEnabled: true,
    lodFrustumCullingEnabled: true,
    lodHysteresisTicks: 4,
    lodSchedulerParallelCounts: 8,
    lodSchedulerExistingTaskLimit: 64,
    lodSchedulerMinDuration: 160,
} satisfies Partial<ViewerParams>;

type SplattingPresetParams = Omit<ViewerParams, keyof typeof VIEWER_SHARED_DEFAULTS | 'splattingPreset'>;

const VIEWER_SPLATTING_PRESETS: Record<Exclude<SplattingPresetId, 'custom'>, SplattingPresetParams> = {
    maxQuality: {
        splatPackType: SplatPackType.Compressed,
        maxSh: 3,
        maxStdDev: 8,
        packHighPrecisionEnabled: true,
        precalculateEnabled: true,
        cameraRelativeEnabled: false,
        autoFreeResourceOnGpuPacked: true,
        compositeEnabled: true,
        renderAttachHighPrecisionEnabled: true,
        detailCullingAlphaEnabled: false,
        detailCullingThreshold: 1,
        minIntervalMs: 0,
    },
    qualityFirst: {
        splatPackType: SplatPackType.Compressed,
        maxSh: 3,
        maxStdDev: 8,
        packHighPrecisionEnabled: true,
        precalculateEnabled: true,
        cameraRelativeEnabled: false,
        autoFreeResourceOnGpuPacked: true,
        compositeEnabled: false,
        renderAttachHighPrecisionEnabled: false,
        detailCullingAlphaEnabled: false,
        detailCullingThreshold: 1,
        minIntervalMs: 0,
    },
    balanced: {
        splatPackType: SplatPackType.SuperCompressed,
        maxSh: 3,
        maxStdDev: 8,
        packHighPrecisionEnabled: false,
        precalculateEnabled: true,
        cameraRelativeEnabled: true,
        autoFreeResourceOnGpuPacked: false,
        compositeEnabled: false,
        renderAttachHighPrecisionEnabled: false,
        detailCullingAlphaEnabled: false,
        detailCullingThreshold: 1,
        minIntervalMs: 0,
    },
    performanceFirst: {
        splatPackType: SplatPackType.SuperCompressed,
        maxSh: 3,
        maxStdDev: 5,
        packHighPrecisionEnabled: false,
        precalculateEnabled: true,
        cameraRelativeEnabled: false,
        autoFreeResourceOnGpuPacked: true,
        compositeEnabled: false,
        renderAttachHighPrecisionEnabled: false,
        detailCullingAlphaEnabled: true,
        detailCullingThreshold: 1,
        minIntervalMs: 0,
    },
    extremePerformance: {
        splatPackType: SplatPackType.SuperCompressed,
        maxSh: 0,
        maxStdDev: 5,
        packHighPrecisionEnabled: false,
        precalculateEnabled: false,
        cameraRelativeEnabled: false,
        autoFreeResourceOnGpuPacked: true,
        compositeEnabled: false,
        renderAttachHighPrecisionEnabled: false,
        detailCullingAlphaEnabled: true,
        detailCullingThreshold: 4,
        minIntervalMs: 160,
    },
};

export function createDefaultParams(): ViewerParams {
    return {
        ...VIEWER_SHARED_DEFAULTS,
        ...VIEWER_SPLATTING_PRESETS.qualityFirst,
        splattingPreset: 'qualityFirst',
    };
}

function applySplattingPreset(params: ViewerParams, preset: SplattingPresetId, keepPrecalculateDisabled: boolean) {
    if (preset !== 'custom') {
        Object.assign(params, VIEWER_SPLATTING_PRESETS[preset]);
    }
    params.splattingPreset = preset;

    if (keepPrecalculateDisabled) {
        params.precalculateEnabled = false;
    }
}

function createSplattingPresetOptions(labels: ViewerLabels) {
    return {
        [labels.presetCustom]: 'custom',
        [labels.presetMaxQuality]: 'maxQuality',
        [labels.presetQualityFirst]: 'qualityFirst',
        [labels.presetBalanced]: 'balanced',
        [labels.presetPerformanceFirst]: 'performanceFirst',
        [labels.presetExtremePerformance]: 'extremePerformance',
    } satisfies Record<string, SplattingPresetId>;
}

export function setupConfigPanel(
    container: HTMLElement,
    labels: ViewerLabels,
    params: ViewerParams,
    shouldKeepPrecalculateDisabled: () => boolean,
    onChange: () => void,
) {
    const pane = new Pane({
        container,
        expanded: true,
    });
    const presetBinding = pane.addBinding(params, 'splattingPreset', {
        label: labels.preset,
        options: createSplattingPresetOptions(labels),
    });
    presetBinding.element.title = labels.presetPackTypeTip;
    let isApplyingSplattingPreset = false;
    const refreshProgrammatic = () => {
        isApplyingSplattingPreset = true;
        pane.refresh();
        queueMicrotask(() => {
            isApplyingSplattingPreset = false;
        });
    };
    presetBinding.on('change', event => {
        applySplattingPreset(params, event.value, shouldKeepPrecalculateDisabled());
        refreshProgrammatic();
        onChange();
    });
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

    const bind = <K extends Exclude<keyof ViewerParams, 'splattingPreset'>>(
        folder: FolderApi,
        key: K,
        options: BindingParams,
    ) =>
        folder
            .addBinding(params, key, options)
            .on(
                'change',
                Object.hasOwn(VIEWER_SPLATTING_PRESETS.qualityFirst, key) ? handleSplattingParamChange : onChange,
            );
    bind(pane, 'pixelRatio', {
        label: 'pixelRatio',
        max: Math.max(2, window.devicePixelRatio),
        min: 0.5,
        step: 0.1,
    });

    const pack = pane.addFolder({ title: labels.packingSettings, expanded: false });
    const raster = pane.addFolder({ title: labels.rasterSettings, expanded: false });
    const sort = pane.addFolder({ title: labels.sortSettings, expanded: false });
    const composite = pane.addFolder({ title: labels.compositeSettings, expanded: false });

    const packing = bind(pack, 'splatPackType', {
        label: 'packType',
        options: {
            Compressed: SplatPackType.Compressed,
            SuperCompressed: SplatPackType.SuperCompressed,
            Sog: SplatPackType.Sog,
        },
    });
    packing.element.title = labels.reimportHint;
    const maxSh = bind(pack, 'maxSh', { label: 'maxShDegree', min: 0, max: 3, step: 1 });
    maxSh.element.title = labels.reimportHint;
    bind(pack, 'packHighPrecisionEnabled', { label: 'highPrecisionEnabled' });
    const repack = bind(pack, 'repackEnabled', { label: 'repackEnabled' });
    repack.element.title = labels.repackTip;
    const radial = bind(sort, 'radial', { label: 'radial' });
    radial.element.title = labels.radialTip;
    bind(pack, 'precalculateEnabled', { label: 'precalculateEnabled' });
    bind(pack, 'cameraRelativeEnabled', { label: 'cameraRelativeEnabled' });
    bind(pack, 'autoFreeResourceOnGpuPacked', { label: 'autoFreeResourceOnGpuPacked' });
    bind(raster, 'preBlurAmount', { label: 'preBlurAmount', min: 0, max: 1, step: 0.1 });
    bind(raster, 'blurAmount', { label: 'blurAmount', min: 0, max: 1, step: 0.1 });
    bind(raster, 'focalAdjustment', { label: 'focalAdjustment', min: 0.5, max: 2, step: 0.1 });
    bind(raster, 'detailCullingThreshold', { label: 'detailCullingThreshold', min: 0, max: 8, step: 1 });
    bind(raster, 'detailCullingAlphaEnabled', { label: 'detailCullingAlphaEnabled' });
    bind(raster, 'maxPixelRadius', { label: 'maxPixelRadius', min: 1, max: 1024, step: 1 });
    bind(raster, 'maxStdDev', { label: 'maxStdDev', min: 5, max: 8, step: 1 });
    bind(sort, 'minIntervalMs', { label: 'minIntervalMs', min: 0, max: 160, step: 16 });
    bind(sort, 'sortSplatDistance', { label: 'sortSplatDistance', min: 0, max: 1, step: 0.01 });
    bind(sort, 'sortSplatCoorient', {
        label: 'sortSplatCoorient',
        min: 0,
        max: 1,
        step: 0.000001,
        format: (value: number) => String(Number(value.toFixed(6))),
    });
    bind(sort, 'sortCameraDistance', { label: 'sortCameraDistance', min: 0, max: 1, step: 0.01 });
    bind(sort, 'sortCameraCoorient', {
        label: 'sortCameraCoorient',
        min: 0,
        max: 1,
        step: 0.000001,
        format: (value: number) => String(Number(value.toFixed(6))),
    });
    bind(composite, 'compositeEnabled', { label: 'enabled' });
    bind(composite, 'renderAttachHighPrecisionEnabled', { label: 'highPrecisionEnabled' });
    bind(composite, 'toneMapping', {
        label: 'toneMapping',
        options: {
            Linear: ToneMapping.Linear,
            Reinhard: ToneMapping.Reinhard,
            ACES: ToneMapping.ACES,
            ACESFilmic: ToneMapping.ACESFilmic,
            Neutral: ToneMapping.Neutral,
        },
    });
    bind(composite, 'exposure', { label: 'exposure', min: 0.1, max: 4, step: 0.1 });

    const highlight = pane.addFolder({ title: labels.highlightSettings, expanded: false });
    bind(highlight, 'highlightEnabled', { label: 'enabled' });
    bind(highlight, 'highlightSize', { label: 'size', min: 1, max: 10, step: 1 });
    bind(highlight, 'highlightColor', { label: 'color' });

    const lod = pane.addFolder({ title: labels.lodSettings, expanded: false });
    bind(lod, 'lodMinLevel', { label: 'minLevel', min: 0, max: 4, step: 1 });
    bind(lod, 'lodMovingMinLevel', { label: 'movingMinLevel', min: 0, max: 4, step: 1 });
    bind(lod, 'lodMaxBudget', {
        label: 'maxBudget',
        min: 1_000_000,
        max: 40_000_000,
        step: 100_000,
    });
    bind(lod, 'lodPixelLimitEnabled', { label: 'pixelLimitEnabled' });
    bind(lod, 'lodFrustumCullingEnabled', { label: 'frustumCullingEnabled' });
    bind(lod, 'lodHysteresisTicks', { label: 'hysteresisTicks', min: 1, max: 10, step: 1 });
    bind(lod, 'lodSchedulerParallelCounts', {
        label: 'schedulerParallelCounts',
        min: 1,
        max: 16,
        step: 1,
    });
    bind(lod, 'lodSchedulerExistingTaskLimit', {
        label: 'schedulerExistingTaskLimit',
        min: 1,
        max: 128,
        step: 1,
    });
    bind(lod, 'lodSchedulerMinDuration', {
        label: 'schedulerMinDuration',
        min: 16,
        max: 1600,
        step: 16,
    });

    for (const input of container.querySelectorAll<HTMLInputElement>('.tp-ckbv_i')) {
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-label', input.closest('.tp-lblv')!.querySelector('.tp-lblv_l')!.textContent!);
    }

    return {
        dispose() {
            pane.dispose();
        },
        refreshProgrammatic,
    };
}

export function applyViewerConfig(viewer: Viewer, params: ViewerParams) {
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
                pack: {
                    highPrecisionEnabled: params.packHighPrecisionEnabled,
                    repackEnabled: params.repackEnabled,
                    precalculateEnabled: params.precalculateEnabled,
                    cameraRelativeEnabled: params.cameraRelativeEnabled,
                },
                raster: {
                    detailCullingAlphaEnabled: params.detailCullingAlphaEnabled,
                    preBlurAmount: params.preBlurAmount,
                    blurAmount: params.blurAmount,
                    focalAdjustment: params.focalAdjustment,
                    detailCullingThreshold: params.detailCullingThreshold,
                    maxPixelRadius: params.maxPixelRadius,
                    maxStdDev: globalThis.Math.sqrt(params.maxStdDev),
                },
                sort: {
                    radial: params.radial,
                    minIntervalMs: params.minIntervalMs,
                    sortSplatDistance: params.sortSplatDistance,
                    sortSplatCoorient: params.sortSplatCoorient,
                    sortCameraDistance: params.sortCameraDistance,
                    sortCameraCoorient: params.sortCameraCoorient,
                },
                composite: {
                    enabled: params.compositeEnabled,
                    highPrecisionEnabled: params.renderAttachHighPrecisionEnabled,
                    toneMapping: params.toneMapping,
                    exposure: params.exposure,
                },
                highlightKernel: {
                    enabled: params.highlightEnabled,
                    size: params.highlightSize,
                    color: Number.parseInt(params.highlightColor.slice(1), 16),
                },
            },
            TAA: { enabled: false },
        },
    });
}

export function getLodConfig(params: ViewerParams): Partial<SplatUtils.LodConfig> {
    return {
        minLevel: params.lodMinLevel,
        movingMinLevel: params.lodMovingMinLevel,
        maxBudget: params.lodMaxBudget,
        pixelLimitEnabled: params.lodPixelLimitEnabled,
        frustumCullingEnabled: params.lodFrustumCullingEnabled,
        hysteresisTicks: params.lodHysteresisTicks,
        schedulerParallelCounts: params.lodSchedulerParallelCounts,
        schedulerExistingTaskLimit: params.lodSchedulerExistingTaskLimit,
        schedulerMinDuration: params.lodSchedulerMinDuration,
    };
}

const NUMBER_LIMITS: Partial<Record<keyof ViewerParams, readonly [number, number]>> = {
    pixelRatio: [0.5, 4],
    maxSh: [0, 3],
    maxStdDev: [5, 8],
    preBlurAmount: [0, 1],
    blurAmount: [0, 1],
    focalAdjustment: [0.5, 2],
    detailCullingThreshold: [0, 8],
    maxPixelRadius: [1, 1024],
    minIntervalMs: [0, 160],
    sortSplatDistance: [0, 1],
    sortSplatCoorient: [0, 1],
    sortCameraDistance: [0, 1],
    sortCameraCoorient: [0, 1],
    exposure: [0.1, 4],
    highlightSize: [1, 10],
    lodMinLevel: [0, 4],
    lodMovingMinLevel: [0, 4],
    lodMaxBudget: [1_000_000, 40_000_000],
    lodHysteresisTicks: [1, 10],
    lodSchedulerParallelCounts: [1, 16],
    lodSchedulerExistingTaskLimit: [1, 128],
    lodSchedulerMinDuration: [0, 1600],
};

export function parseSavedParams(value: unknown): ViewerParams {
    if (!value || typeof value !== 'object') {
        throw new Error('Invalid viewer settings.');
    }
    const saved = value as Record<string, unknown>;
    const params = createDefaultParams();
    for (const key of Object.keys(params) as (keyof ViewerParams)[]) {
        const item = saved[key];
        if (item === undefined) {
            continue;
        }
        if (key === 'splattingPreset' && (item === 'extremePerformance0' || item === 'extremePerformance1')) {
            params.splattingPreset = 'extremePerformance';
            continue;
        }
        if (typeof item !== typeof params[key] || (typeof item === 'number' && !Number.isFinite(item))) {
            throw new Error(`Invalid viewer setting: ${key}`);
        }
        const limits = NUMBER_LIMITS[key];
        if (limits && typeof item === 'number' && (item < limits[0] || item > limits[1])) {
            throw new Error(`Viewer setting out of range: ${key}`);
        }
        Object.assign(params, { [key]: item });
    }
    if (
        (params.splattingPreset !== 'custom' && !Object.hasOwn(VIEWER_SPLATTING_PRESETS, params.splattingPreset)) ||
        ![SplatPackType.Compressed, SplatPackType.SuperCompressed, SplatPackType.Sog].includes(params.splatPackType) ||
        !Object.values(ToneMapping).includes(params.toneMapping) ||
        !/^#[\da-f]{6}$/iu.test(params.highlightColor)
    ) {
        throw new Error('Invalid viewer settings.');
    }
    return params;
}

export function restoreViewerParams(id: string) {
    const text = localStorage.getItem(`aholo:viewer:settings:${VIEWER_SETTINGS_VERSION}:${id}`);
    const cached: { version?: unknown; params?: unknown } | null = text ? JSON.parse(text) : null;
    return cached?.version === VIEWER_SETTINGS_VERSION ? parseSavedParams(cached.params) : createDefaultParams();
}

export function saveViewerParams(id: string, params: ViewerParams) {
    localStorage.setItem(
        `aholo:viewer:settings:${VIEWER_SETTINGS_VERSION}:${id}`,
        JSON.stringify({ version: VIEWER_SETTINGS_VERSION, params }),
    );
}
