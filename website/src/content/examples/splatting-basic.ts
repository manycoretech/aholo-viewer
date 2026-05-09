import { type Viewer, setViewerConfig, ToneMapping, SplatLoader, SplatUtils, Vector3 } from '@manycore/aholo-viewer';
import type { RenderRuntime, RuntimeConfigPanel, RuntimeIndexedDBStorage } from '../../client/render-runtime';

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
    );
    throwIfAborted(signal);
    const splat = await SplatUtils.createSplat(data);
    throwIfAborted(signal);
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
        normalizedFalloff: false,
        preBlurAmount: 0.3,
        blurAmount: 0,
        focalAdjustment: 2,
        detailCullingThreshold: 1,
        toneMappingEnabled: false,
        toneMapping: ToneMapping.Neutral,
        exposure: 1,
    };

    const applyConfig = () => {
        setViewerConfig(viewer, {
            pipeline: {
                Splatting: {
                    precalculateEnabled: params.precalculateEnabled,
                    normalizedFalloff: params.normalizedFalloff,
                    preBlurAmount: params.preBlurAmount,
                    blurAmount: params.blurAmount,
                    focalAdjustment: params.focalAdjustment,
                    detailCullingThreshold: params.detailCullingThreshold,
                    toneMapping: {
                        enabled: params.toneMappingEnabled,
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
    pane.addBinding(params, 'normalizedFalloff', { label: 'Normalized falloff' }).on('change', applyConfig);
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

    const toneMapping = pane.addFolder({ title: 'Tone Mapping', expanded: false });
    toneMapping.addBinding(params, 'toneMappingEnabled', { label: 'Enabled' }).on('change', applyConfig);
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
        .on('change', applyConfig);
    toneMapping
        .addBinding(params, 'exposure', { label: 'Exposure', max: 2, min: 0.1, step: 0.1 })
        .on('change', applyConfig);
}

type ISplatData = ReturnType<SplatLoader.SplatData['serialize']>;

const CACHE_KEY = 'splatting-basic:bear';
const CACHE_VERSION = 0;
async function loadSplatData(url: string, db: RuntimeIndexedDBStorage) {
    const cached = await db.get<ISplatData>(CACHE_KEY, { version: CACHE_VERSION });
    if (cached) {
        const data = new SplatLoader.SuperCompressedSplatData();
        data.deserialize(cached);
        return data;
    }

    const data = await SplatLoader.parseSplatData(SplatLoader.SplatFileType.SOG, url);
    await db.set(CACHE_KEY, data.serialize(), { version: CACHE_VERSION });
    return data;
}
