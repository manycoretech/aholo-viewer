import { type Viewer, setViewerConfig, ToneMapping, SplatLoader, SplatUtils, Vector3 } from '@manycore/aholo-viewer';
import type { RenderRuntime, RuntimeConfigPanel, RuntimeIndexedDBStorage } from '../../client/render-runtime.js';

export default async function runner({ renderer, control, loading, configPanel, indexedDB, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    setViewerConfig(viewer, {
        pipeline: {
            Splatting: { enabled: true },
        },
    });
    initConfigPanel(viewer, configPanel);

    const camera = viewer.getCamera();
    camera.up.set(0, -1, 0);
    camera.position.set(-1.5, -0.5, 0);
    camera.lookAt(new Vector3(0, 0, 0));
    control.setOptions({ enabled: true, useOrbit: true });

    loading.show('Loading splat data');
    const data = await loadSplatData(
        'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/bear/bear.3d71a266.sog',
        indexedDB,
        signal,
    );
    throwIfAborted(signal);
    const splat = await SplatUtils.createSplat(data);
    if (signal.aborted) {
        splat.destroy();
        throwIfAborted(signal);
    }
    scene.add(splat);

    renderer.frame(({ delta }) => control.update(delta));

    renderer.render();
    loading.hide();

    return () => {
        scene?.remove(splat);
        splat?.destroy();
    };
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException('The splatting basic sample load was aborted.', 'AbortError');
    }
}

function initConfigPanel(viewer: Viewer, configPanel: RuntimeConfigPanel) {
    const params = {
        precalculateEnabled: true,
        detailCullingAlphaEnabled: false,
        preBlurAmount: 0.3,
        blurAmount: 0,
        focalAdjustment: 2,
        detailCullingThreshold: 1,
        compositeEnabled: false,
        compositeHighPrecisionEnabled: true,
        toneMapping: ToneMapping.Neutral,
        exposure: 1,
    };

    const applyConfig = () => {
        setViewerConfig(viewer, {
            pipeline: {
                Splatting: {
                    pack: {
                        precalculateEnabled: params.precalculateEnabled,
                    },
                    raster: {
                        detailCullingAlphaEnabled: params.detailCullingAlphaEnabled,
                        preBlurAmount: params.preBlurAmount,
                        blurAmount: params.blurAmount,
                        focalAdjustment: params.focalAdjustment,
                        detailCullingThreshold: params.detailCullingThreshold,
                    },
                    composite: {
                        enabled: params.compositeEnabled,
                        highPrecisionEnabled: params.compositeHighPrecisionEnabled,
                        toneMapping: params.toneMapping,
                        exposure: params.exposure,
                    },
                },
            },
        });
    };

    applyConfig();

    const pane = configPanel.createPane({ title: 'Splatting' });
    pane.addBinding(params, 'precalculateEnabled', { label: 'Precalculate SH' }).on('change', applyConfig);
    pane.addBinding(params, 'detailCullingAlphaEnabled', { label: 'Cull by alpha' }).on('change', applyConfig);
    pane.addBinding(params, 'preBlurAmount', { label: 'Pre blur', max: 1, min: 0, step: 0.1 }).on(
        'change',
        applyConfig,
    );
    pane.addBinding(params, 'blurAmount', { label: 'Blur', max: 1, min: 0, step: 0.1 }).on('change', applyConfig);
    pane.addBinding(params, 'focalAdjustment', { label: 'Focal adjustment', max: 2, min: 0.5, step: 0.1 }).on(
        'change',
        applyConfig,
    );
    pane.addBinding(params, 'detailCullingThreshold', { label: 'Detail culling', max: 4, min: 0, step: 1 }).on(
        'change',
        applyConfig,
    );

    const composite = pane.addFolder({ title: 'Composite', expanded: false });
    composite.addBinding(params, 'compositeEnabled', { label: 'Enabled' }).on('change', applyConfig);
    composite
        .addBinding(params, 'compositeHighPrecisionEnabled', { label: 'High precision' })
        .on('change', applyConfig);
    composite
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
        .on('change', applyConfig);
    composite
        .addBinding(params, 'exposure', { label: 'Exposure', max: 2, min: 0.1, step: 0.1 })
        .on('change', applyConfig);
}

type ISplatData = ReturnType<SplatLoader.SplatData['serialize']>;

const CACHE_KEY = 'splatting-basic:bear';
const CACHE_VERSION = 0;
async function loadSplatData(url: string, db: RuntimeIndexedDBStorage, signal: AbortSignal) {
    const cached = await db.get<ISplatData>(CACHE_KEY, { version: CACHE_VERSION });
    throwIfAborted(signal);
    if (cached) {
        const data = new SplatLoader.SuperCompressedSplatData();
        data.deserialize(cached);
        return data;
    }

    const data = await SplatLoader.parseSplatData(
        SplatLoader.SplatFileType.SOG,
        url,
        SplatLoader.SplatPackType.SuperCompressed,
        { signal },
    );
    await db.set(CACHE_KEY, data.serialize(), { version: CACHE_VERSION });
    return data;
}
