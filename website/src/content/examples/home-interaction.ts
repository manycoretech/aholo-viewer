import { createViewerContext, setViewerConfig, SplatLoader, SplatUtils, ToneMapping } from '@manycore/aholo-viewer';
import type { RenderRuntime, RuntimeIndexedDBStorage } from '../../client/render-runtime';

const HOME_INTERACTION_ENTER_EVENT = 'aholo:home-interaction-enter';

export default async function runner({ renderer, control, loading, indexedDB, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    setViewerConfig(viewer, {
        pipeline: {
            Splatting: {
                enabled: true,
                preBlurAmount: 0.3,
                blurAmount: 0,
                focalAdjustment: 2,
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

    loading.show('Loading home interaction');
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
            minLevel: meta.levels - 1,
            maxBudget: 2000000,
            schedulerParallelCounts: 99999,
        },
        createViewerContext(viewer),
        url => loadResource(url, indexedDB),
    );
    scene.add(splat.container);

    splat.tick(viewer.getCamera());
    splat.start();
    renderer.render();
    await splat.onFinishSchedule();
    if (signal.aborted) {
        splat.destroy();
        throwIfAborted(signal);
    }
    loading.hide();

    await waitForHomeInteraction(signal);
    throwIfAborted(signal);

    splat.setConfig({
        minLevel: 0,
        schedulerParallelCounts: 4,
    });
    renderer.frame(({ delta }) => {
        const updated = control.update(delta);
        splat.tick(viewer.getCamera());
        return updated;
    });

    return () => splat.destroy();
}

function waitForHomeInteraction(signal: AbortSignal) {
    if (document.documentElement.classList.contains('home-interactive')) {
        return Promise.resolve();
    }
    if (signal.aborted) {
        return Promise.reject(new DOMException('The home interaction load was aborted.', 'AbortError'));
    }

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            document.removeEventListener(HOME_INTERACTION_ENTER_EVENT, handleEnter);
            signal.removeEventListener('abort', handleAbort);
        };
        const handleEnter = () => {
            cleanup();
            resolve();
        };
        const handleAbort = () => {
            cleanup();
            reject(new DOMException('The home interaction load was aborted.', 'AbortError'));
        };

        document.addEventListener(HOME_INTERACTION_ENTER_EVENT, handleEnter, { once: true });
        signal.addEventListener('abort', handleAbort, { once: true });
    });
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
        throw new DOMException('The home LOD stream sample load was aborted.', 'AbortError');
    }
}
