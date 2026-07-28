import {
    createViewerContext,
    setViewerConfig,
    SplatLoader,
    SplatUtils,
    ToneMapping,
    type Viewer,
} from '@manycore/aholo-viewer';
import type { RenderRuntime, RuntimeConfigPanel, RuntimeIndexedDBStorage } from '../../client/render-runtime.js';

const LodConfig: Omit<
    SplatUtils.LodConfig,
    'debuggerEnabled' | 'debuggerType' | 'distanceStep' | 'mergeNodeEnabled' | 'frustumCullingEnabled'
> & {
    highPrecisionEnabled: boolean;
    maxBudgetMillions: number;
} = {
    minLevel: 0,
    maxBudget: 6000000,
    backgroundPenalty: 0.5,
    hysteresisTicks: 4,
    schedulerParallelCounts: 4,
    schedulerExistingTaskLimit: 64,
    schedulerMinDuration: 160,
    highPrecisionEnabled: false,
    maxBudgetMillions: 6,
};

export default async function runner({ renderer, control, loading, configPanel, indexedDB, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    setViewerConfig(viewer, {
        pipeline: {
            Splatting: {
                enabled: true,
                pack: {
                    precalculateEnabled: false,
                },
                toneMapping: {
                    enabled: true,
                    toneMapping: ToneMapping.Neutral,
                },
            },
        },
    });
    const camera = viewer.getCamera();
    camera.up.set(0, -1, 0);
    camera.position.set(-0.9800918057099783, -1.7506846691679372, 2.292388933466888);
    camera.rotation.set(0.11785010330530897, -0.030190695395364366, -3.133801078676436);
    control.setOptions({ enabled: true });

    loading.show('Streaming initial LOD');
    const envData = await loadResource(
        'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/misc/home-interaction-env.73524ff2.sog',
        indexedDB,
    );
    const env = await SplatUtils.createSplat(envData);
    scene.add(env);

    const meta = await loadLodMeta(
        'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/huochezhan/chunk-lod/6b077ba2/lod-meta.json',
        signal,
    );
    throwIfAborted(signal);

    const splat = new SplatUtils.LodSplat(
        meta,
        {
            ...LodConfig,
            minLevel: meta.levels - 1,
            schedulerParallelCounts: 99999,
        },
        createViewerContext(viewer),
        url => loadResource(url, indexedDB),
    );
    scene.add(splat.container);

    splat.tick(camera);
    splat.start();
    await splat.onFinishSchedule();
    if (signal.aborted) {
        splat.destroy();
        throwIfAborted(signal);
    }
    loading.hide();

    if (signal.aborted) {
        splat.destroy();
        throwIfAborted(signal);
    }

    initConfigPanel(splat, configPanel, viewer);

    renderer.frame(({ delta }) => {
        const updated = control.update(delta);
        splat.tick(viewer.getCamera());
        return updated;
    });

    return () => splat.destroy();
}

function initConfigPanel(splat: SplatUtils.LodSplat, configPanel: RuntimeConfigPanel, viewer: Viewer) {
    const applyConfig = () => {
        if (LodConfig.highPrecisionEnabled) {
            setViewerConfig(viewer, {
                pipeline: {
                    Splatting: {
                        pack: {
                            highPrecisionEnabled: true,
                            cameraRelativeEnabled: false,
                        },
                    },
                },
            });
        } else {
            setViewerConfig(viewer, {
                pipeline: {
                    Splatting: {
                        pack: {
                            highPrecisionEnabled: false,
                            cameraRelativeEnabled: true,
                        },
                    },
                },
            });
        }
        LodConfig.maxBudget = LodConfig.maxBudgetMillions * 1_000_000;
        splat.setConfig(LodConfig);
    };
    applyConfig();

    const panel = configPanel.createPane({ title: 'Splatting LOD Stream' });
    panel.addBinding(LodConfig, 'highPrecisionEnabled', { label: 'High precision' }).on('change', applyConfig);
    const budget = panel.addFolder({ title: 'LOD Budget', expanded: true });
    budget
        .addBinding(LodConfig, 'minLevel', {
            label: 'Min level',
            max: 4,
            min: 0,
            step: 1,
        })
        .on('change', applyConfig);
    budget
        .addBinding(LodConfig, 'maxBudgetMillions', {
            label: 'Max budget (M)',
            max: 20,
            min: 1,
            step: 0.1,
        })
        .on('change', applyConfig);

    const visibility = panel.addFolder({ title: 'Visibility Weights', expanded: false });
    visibility
        .addBinding(LodConfig, 'backgroundPenalty', {
            label: 'Background',
            max: 1,
            min: 0,
            step: 0.05,
        })
        .on('change', applyConfig);
    visibility
        .addBinding(LodConfig, 'hysteresisTicks', {
            label: 'Hysteresis',
            max: 12,
            min: 0,
            step: 1,
        })
        .on('change', applyConfig);

    const scheduler = panel.addFolder({ title: 'Streaming Scheduler', expanded: false });
    scheduler
        .addBinding(LodConfig, 'schedulerParallelCounts', {
            label: 'Parallel',
            max: 16,
            min: 1,
            step: 1,
        })
        .on('change', applyConfig);
    scheduler
        .addBinding(LodConfig, 'schedulerExistingTaskLimit', {
            label: 'Cached tasks',
            max: 256,
            min: 1,
            step: 1,
        })
        .on('change', applyConfig);
    scheduler
        .addBinding(LodConfig, 'schedulerMinDuration', {
            label: 'Min duration',
            max: 500,
            min: 0,
            step: 20,
        })
        .on('change', applyConfig);
}

async function loadLodMeta(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal });
    const content = await response.json();
    if (!(content.magicCode === 2500660 && content.type === 'lod-splat')) {
        throw new Error('LOD metadata is not a supported lod-splat manifest.');
    }
    return content as SplatUtils.LodMeta;
}

type ISplatData = ReturnType<SplatLoader.SplatData['serialize']>;
async function loadResource(url: string, db: RuntimeIndexedDBStorage) {
    const cached = await db.get<ISplatData>(url, { version: 0 });
    if (cached) {
        const data = new SplatLoader.CompressedSplatData();
        data.deserialize(cached);
        return data;
    }

    const fileType = SplatLoader.detectSplatFileType(url, new Uint8Array());
    if (fileType === undefined) {
        throw new Error(`Unsupported LOD splat resource: ${url}`);
    }

    const data = await SplatLoader.parseSplatData(fileType, url, SplatLoader.SplatPackType.Compressed);
    await db.set(url, data.serialize(), { version: 0 });
    return data;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException('The splatting LOD stream sample load was aborted.', 'AbortError');
    }
}
