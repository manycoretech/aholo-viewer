import {
    BackgroundMode,
    Color,
    createViewerContext,
    Matrix4,
    PerspectiveCamera,
    setViewerConfig,
    SplatLoader,
    SplatUtils,
    Vector3,
    XR,
    type Splat,
    type Viewer,
    type Viewport,
} from '@manycore/aholo-viewer';
import type { RenderRuntime } from '../../client/render-runtime.js';

// WALK_OUTDOOR from walk-demo: meter units, +Y up, camera forward along -Z.
// Unlike the millimeter / +Z-up mesh example, this scene needs no axis conversion.
const SCENE_URL = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/juguo/';
const LOD_URL = `${SCENE_URL}chunk-lod/0f9e3ae1/lod-meta.json`;
const SPAWN = { x: 20.398008, y: -0.15, z: 62.773942, yaw: -0.384 };
const EYE_HEIGHT = 1.4; // Same ground-to-eye distance as the walk demo.
type XRPlugin = Awaited<ReturnType<typeof XR.initWebXR>>;
type SplatData = ReturnType<SplatLoader.CompressedSplatData['serialize']>;

export default async function runner({ renderer, loading, configPanel, indexedDB, signal }: RenderRuntime) {
    const { viewer, scene } = renderer;
    const camera = viewer.getCamera() as PerspectiveCamera;
    camera.up.set(0, 1, 0);
    camera.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    camera.rotation.set(-0.15, SPAWN.yaw, 0, 'YXZ');
    camera.near = 0.05;
    camera.far = 1000;
    camera.updateProjectionMatrix();
    configureView(viewer);

    let environment: Splat | undefined;
    let lod: SplatUtils.LodSplat | undefined;
    let plugin: XRPlugin | undefined;
    let entering = false;
    const pixelRatio = viewer.config.canvas.renderPixelRatio.get();
    const pane = configPanel.createPane({ title: 'WebXR VR' });
    const state = { status: 'Loading scene', views: 0 };
    pane.addBinding(state, 'status', { label: 'Status', readonly: true, multiline: true, rows: 2 });
    pane.addBinding(state, 'views', { label: 'XR views', readonly: true, format: value => value.toFixed(0) });
    const enterButton = pane.addButton({ title: 'Enter VR', disabled: true });
    const exitButton = pane.addButton({ title: 'Exit VR', disabled: true });
    signal.addEventListener('abort', dispose, { once: true });

    try {
        loading.show('loading');
        environment = await SplatUtils.createSplat(await loadResource(`${SCENE_URL}environment.d3e129aa.ply`));
        throwIfAborted();
        scene.add(environment);

        const response = await fetch(LOD_URL, { signal });
        if (!response.ok) throw new Error(`LOD metadata: HTTP ${response.status}`);
        const meta = (await response.json()) as SplatUtils.LodMeta;
        throwIfAborted();
        if (meta.magicCode !== 2500660 || meta.type !== 'lod-splat') throw new Error('Invalid LOD metadata.');
        lod = new SplatUtils.LodSplat(
            meta,
            {
                minLevel: meta.levels - 1,
                maxBudget: 6_000_000,
                backgroundPenalty: 1,
                // Keep both eyes covered instead of selecting chunks for only one eye's frustum.
                frustumCullingEnabled: false,
            },
            createViewerContext(viewer),
            loadResource,
        );
        scene.add(lod.container);
        lod.tick(camera);
        lod.start();
        await lod.onFinishSchedule();
        throwIfAborted();
        lod.setConfig({ minLevel: 0 });
        renderer.frame(() => {
            lod?.tick(camera);
            return false;
        });
        renderer.render();
        loading.hide();

        const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
        const supported = await xr?.isSessionSupported('immersive-vr').catch(() => false);
        throwIfAborted();
        state.status = supported ? 'Ready' : 'VR unavailable. Connect a headset or enable the emulator.';
        enterButton.disabled = !supported;
        pane.refresh();
        enterButton.on('click', () => void enterVR());
        exitButton.on('click', () => void plugin?.session.end());
        return dispose;
    } catch (error) {
        dispose();
        throw error;
    }

    async function enterVR() {
        if (entering || plugin || signal.aborted) return;
        entering = true;
        enterButton.disabled = true;
        state.status = 'Starting VR';
        pane.refresh();

        // local-floor supplies the user's real eye height. Only translate and apply spawn yaw;
        // do not bake the desktop camera's pitch into the headset's world orientation.
        const origin = new Matrix4().makeRotationY(SPAWN.yaw);
        origin.setPosition(new Vector3(SPAWN.x, SPAWN.y - EYE_HEIGHT, SPAWN.z));
        const lodCamera = new PerspectiveCamera();
        try {
            const next = await XR.initWebXR({
                session: 'immersive-vr',
                referenceSpace: 'local-floor',
                requiredFeatures: ['local-floor'],
                computeCameraMatrix(transform, eye) {
                    const matrix = new Matrix4().multiplyMatrices(origin, new Matrix4().fromArray(transform));
                    if (eye === 0) {
                        lodCamera.matrix = matrix;
                        lod?.tick(lodCamera);
                    }
                    return matrix;
                },
            });
            if (signal.aborted) {
                await next.session.end();
                return;
            }
            plugin = next;
            next.session.addEventListener('end', onSessionEnd, { once: true });
            next.on(XR.OnXRViewChanged, views => {
                views.forEach(configureView);
                state.views = views.length;
                state.status = views.length === 2 ? 'Stereo VR' : 'Enable Stereo in the emulator';
                pane.refresh();
            });
            renderer.setExternalRendering(true);
            next.registerToViewer(viewer);
            exitButton.disabled = false;
        } catch (error) {
            leaveVR();
            if (!signal.aborted) {
                state.status = error instanceof Error ? error.message : String(error);
            }
        } finally {
            entering = false;
            if (!signal.aborted) {
                enterButton.disabled = !!plugin;
                pane.refresh();
            }
        }
    }

    function onSessionEnd() {
        // egs-xr calls end() again during destroy. The session has already ended here.
        if (plugin) plugin.session.end = () => Promise.resolve();
        leaveVR();
    }

    function leaveVR() {
        const current = plugin;
        if (!current) return;
        plugin = undefined;
        current.session.removeEventListener('end', onSessionEnd);
        // For production, destroy and recreate the Viewer when exiting VR.
        // unregisterFromViewer is used only for this quick example. This path is
        // currently unstable and is not recommended for production use.
        // egs-xr implements the method, but its published plugin type omits it.
        (current as XRPlugin & { unregisterFromViewer(): void }).unregisterFromViewer();
        if (signal.aborted) return;
        viewer.clearViewport();
        const preview = viewer.createViewport('preview');
        preview.camera = camera;
        configureView(preview);
        setViewerConfig(preview, { pixelRatio });
        renderer.setExternalRendering(false, camera);
        state.status = 'Ready';
        state.views = 0;
        enterButton.disabled = false;
        exitButton.disabled = true;
        pane.refresh();
    }

    function dispose() {
        signal.removeEventListener('abort', dispose);
        leaveVR();
        lod?.destroy();
        lod = undefined;
        environment?.removeFromParent();
        environment?.destroy();
        environment = undefined;
    }

    function throwIfAborted() {
        if (signal.aborted) throw new DOMException('The WebXR VR sample was aborted.', 'AbortError');
    }

    async function loadResource(path: string) {
        const url = new URL(path, LOD_URL).href;
        const cached = await indexedDB.get<SplatData>(url, { version: 0 });
        throwIfAborted();
        if (cached) {
            const data = new SplatLoader.CompressedSplatData();
            data.deserialize(cached);
            return data;
        }
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Splat resource: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        throwIfAborted();
        const type = SplatLoader.detectSplatFileType(url, bytes);
        if (type === undefined) throw new Error(`Unsupported splat: ${url}`);
        const data = await SplatLoader.parseSplatData(type, bytes, SplatLoader.SplatPackType.Compressed);
        throwIfAborted();
        await indexedDB.set(url, data.serialize(), { version: 0 });
        throwIfAborted();
        return data;
    }
}

function configureView(view: Viewer | Viewport) {
    setViewerConfig(view, {
        pipeline: {
            Splatting: { enabled: true },
            TAA: { enabled: false },
            Background: {
                ground: { enabled: false },
                background: { active: BackgroundMode.BasicBackground, basic: { color: new Color(0, 0, 0) } },
            },
        },
    });
}
