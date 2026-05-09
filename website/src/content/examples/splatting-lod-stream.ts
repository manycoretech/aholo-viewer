import { createViewerContext, setViewerConfig, SplatLoader, SplatUtils, ToneMapping } from '@manycore/aholo-viewer';
import type { RenderRuntime, RuntimeConfigPanel, RuntimeIndexedDBStorage } from '../../client/render-runtime';

const LodConfig: Omit<SplatUtils.LodConfig, 'debuggerEnabled' | 'debuggerType' | 'distanceStep'> & {
    maxBudgetMillions: number;
} = {
    minLevel: 0,
    maxBudget: 8000000,
    backgroundPenalty: 0.5,
    outsidePenalty: 0.4,
    behindPenalty: 0.1,
    behindTolerance: -0.2,
    behindDistanceTolerance: 2,
    hysteresisTicks: 4,
    schedulerParallelCounts: 4,
    schedulerExistingTaskLimit: 64,
    schedulerMinDuration: 160,
    maxBudgetMillions: 8,
};

export default async function runner({ renderer, control, loading, configPanel, indexedDB, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    setViewerConfig(viewer, {
        pipeline: {
            Splatting: {
                enabled: true,
                packHighPrecisionEnabled: true,
                precalculateEnabled: false,
                toneMapping: {
                    enabled: true,
                    toneMapping: ToneMapping.Neutral,
                },
            },
        },
    });
    const camera = viewer.getCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(3.8955188792160604, 4.78942301156218, 2.547649865689554);
    camera.rotation.set(-0.6918980151400992, 1.0657382790225007, 2.3288403005504987);
    control.setOptions({ enabled: true });

    loading.show('Streaming initial LOD');
    const envData = await loadResource(
        'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/misc/lod-env.24ee228c.sog',
        indexedDB,
    );
    const env = await SplatUtils.createSplat(envData);
    scene.add(env);

    const meta = await loadLodMeta(
        'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/daqiao/chunk-lod/f013993d/lod-meta.json',
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

    initConfigPanel(splat, configPanel);

    renderer.frame(({ delta }) => {
        const updated = control.update(delta);
        splat.tick(viewer.getCamera());
        return updated;
    });

    return () => splat.destroy();
}

function initConfigPanel(splat: SplatUtils.LodSplat, configPanel: RuntimeConfigPanel) {
    const applyConfig = () => {
        LodConfig.maxBudget = LodConfig.maxBudgetMillions * 1_000_000;
        splat.setConfig(LodConfig);
    };
    applyConfig();

    const panel = configPanel.createPane({ title: 'Splatting LOD Stream' });
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
        .addBinding(LodConfig, 'outsidePenalty', {
            label: 'Outside',
            max: 1,
            min: 0,
            step: 0.05,
        })
        .on('change', applyConfig);
    visibility
        .addBinding(LodConfig, 'behindPenalty', {
            label: 'Behind',
            max: 1,
            min: 0,
            step: 0.05,
        })
        .on('change', applyConfig);
    visibility
        .addBinding(LodConfig, 'behindTolerance', {
            label: 'Behind dot',
            max: 0.5,
            min: -1,
            step: 0.05,
        })
        .on('change', applyConfig);
    visibility
        .addBinding(LodConfig, 'behindDistanceTolerance', {
            label: 'Behind dist',
            max: 12,
            min: 0,
            step: 0.5,
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
