import {
    AmbientLight,
    Box3,
    DirectionalLight,
    PerspectiveCamera,
    Scene3D,
    SplatLoader,
    SplatUtils,
    TypeAssert,
    Vector3,
    createViewer,
    createViewerContext,
} from '@manycore/aholo-viewer';
import { CameraControl } from './camera-control.js';
import { abortable, syncCameraAspect } from './rendering.js';
import { applyViewerConfig, getLodConfig, type ViewerParams } from './viewer-config.js';
import {
    MODEL_EXTENSIONS,
    createStreamedSplat,
    disposeObject,
    extension,
    inspectSplatSource,
    loadGltfAsset,
    lodBounds,
    type AssetSource,
    type LoadedAsset,
} from './viewer-assets.js';
import type { ViewerLabels } from './viewer-labels.js';

export interface AssetRecord {
    id: number;
    source: AssetSource;
    controller: AbortController;
    status: 'loading' | 'ready' | 'error';
    error?: string;
    asset?: LoadedAsset;
}

export type CoordinateSystem = 'aholo' | 'opengl' | 'opencv';
export type ViewId = 'A' | 'B' | 'C' | 'D';

export class ViewerScene {
    readonly viewer;
    readonly scene = new Scene3D();
    readonly camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    readonly control: CameraControl;
    readonly records: AssetRecord[] = [];
    readonly bounds = new Box3();
    coordinateSystem: CoordinateSystem = 'opencv';
    contextLost = false;
    private nextRecordId = 1;
    private destroyed = false;

    constructor(
        readonly id: ViewId,
        readonly surface: HTMLElement,
        readonly params: ViewerParams,
        private readonly labels: ViewerLabels,
        private readonly onChange: () => void,
    ) {
        this.viewer = createViewer(`aholo-viewer-${id}-${Date.now()}`, surface, { antialiasing: false });
        this.control = new CameraControl(this.camera, surface, { enabled: true });
        this.viewer.setScene(this.scene);
        this.viewer.setCamera(this.camera);
        const ambient = new AmbientLight(0xffffff, 0.75);
        const key = new DirectionalLight(0xffffff, 1.0);
        key.position.set(1, 2, 3);
        this.scene.add(ambient);
        this.scene.add(key);
        this.setCoordinateSystem('opencv');
        this.applySettings();
        surface.addEventListener('webglcontextlost', this.onContextLost, true);
    }

    get keepPrecalculateDisabled() {
        return this.records.some(record => record.asset?.shDegree === 0);
    }

    applySettings() {
        applyViewerConfig(this.viewer, this.params);
        for (const record of this.records) {
            const asset = record.asset;
            if (asset?.lod) {
                asset.lod.setConfig(getLodConfig(this.params));
            } else if (asset && TypeAssert.isSplat(asset.object)) {
                asset.object.autoFreeResourceOnGpuPacked = this.params.autoFreeResourceOnGpuPacked;
            }
        }
        this.scene.notifySceneChange();
    }

    async importSources(sources: AssetSource[], append: boolean) {
        if (this.contextLost) {
            throw new Error(this.labels.lostHint);
        }
        if (!sources.length) {
            return;
        }
        if (!append) {
            this.clear();
        }
        const frameOnLoad = this.records.length === 0;
        if (frameOnLoad && /\.(gltf|glb)$/iu.test(sources[0].name)) {
            this.setCoordinateSystem('opengl');
        }
        const batch: AssetRecord[] = sources.map(source => ({
            id: this.nextRecordId++,
            source,
            controller: new AbortController(),
            status: 'loading',
        }));
        this.records.push(...batch);
        this.onChange();
        for (const record of batch) {
            const { signal } = record.controller;
            if (signal.aborted) {
                continue;
            }
            try {
                if (!MODEL_EXTENSIONS.includes(extension(record.source.name))) {
                    throw new Error(`${this.labels.unsupportedFileType}: ${record.source.name}`);
                }
                const asset = await this.loadAsset(record);
                if (signal.aborted) {
                    asset.dispose();
                    continue;
                }
                record.asset = asset;
                record.status = 'ready';
                this.scene.add(asset.object);
                if (asset.shDegree === 0) {
                    this.params.precalculateEnabled = false;
                }
                this.updateBounds();
                this.applySettings();
            } catch (error) {
                if (signal.aborted) {
                    continue;
                }
                record.asset?.dispose();
                record.asset = undefined;
                record.status = 'error';
                record.error = error instanceof Error ? error.message : String(error);
            }
            if (!this.destroyed) {
                this.onChange();
            }
        }
        if (frameOnLoad && !this.destroyed) {
            this.frameModels();
        }
    }

    private async loadAsset(record: AssetRecord): Promise<LoadedAsset> {
        const {
            source,
            controller: { signal },
        } = record;
        if (/\.(gltf|glb)$/iu.test(source.name)) {
            return loadGltfAsset(source, signal, this.labels);
        }
        const input = await inspectSplatSource(source, signal);
        if (input.lod) {
            const meta = input.lod;
            const baseUrl = source.kind === 'url' ? source.url : undefined;
            const lod = new SplatUtils.LodSplat(
                meta,
                {
                    ...getLodConfig(this.params),
                    minLevel: Math.max(0, meta.levels - 1),
                },
                createViewerContext(this.viewer),
                async (url, resourceSignal) => {
                    const combined = resourceSignal ? AbortSignal.any([signal, resourceSignal]) : signal;
                    const resourceUrl = new URL(url, baseUrl ?? window.location.href).href;
                    const type = SplatLoader.detectSplatFileType(resourceUrl, new Uint8Array());
                    if (type === undefined) {
                        throw new Error(`Unsupported LOD resource: ${resourceUrl}`);
                    }
                    return SplatLoader.parseSplatData(type, resourceUrl, SplatLoader.SplatPackType.Compressed, {
                        signal: combined,
                    });
                },
            );
            const asset: LoadedAsset = {
                object: lod.container,
                bounds: lodBounds(meta),
                format: 'LOD',
                splatCount: meta.counts,
                shDegree: meta.shDegree,
                lod,
                dispose() {
                    lod.container.removeFromParent();
                    lod.destroy();
                },
            };
            record.asset = asset;
            this.scene.add(lod.container);
            lod.tick(this.camera);
            lod.start();
            try {
                await abortable(lod.onFinishSchedule(), signal, 'LOD loading was aborted.');
                signal.throwIfAborted();
                lod.setConfig(getLodConfig(this.params));
                return asset;
            } catch (error) {
                // Removal owns disposal once the asset is attached to its record.
                if (!signal.aborted) {
                    asset.dispose();
                    record.asset = undefined;
                }
                throw error;
            }
        }
        const data = await SplatLoader.parseSplatData(input.type, input.input, this.params.splatPackType, {
            retainData: false,
            maxShDegree: this.params.maxSh,
            maxTextureSize: 8192,
            signal,
        });
        signal.throwIfAborted();
        const { object: splat, bounds } = await createStreamedSplat(data, this.viewer);
        return {
            object: splat,
            bounds,
            format: SplatLoader.SplatFileType[input.type] ?? extension(source.name).slice(1).toUpperCase(),
            splatCount: data.counts,
            shDegree: data.shDegree,
            dispose() {
                disposeObject(splat);
            },
        };
    }

    remove(id: number) {
        const index = this.records.findIndex(record => record.id === id);
        if (index < 0) {
            return;
        }
        const [record] = this.records.splice(index, 1);
        record.controller.abort();
        record.asset?.dispose();
        this.updateBounds();
        this.scene.notifySceneChange();
        this.onChange();
    }

    clear() {
        for (const record of this.records.splice(0)) {
            record.controller.abort();
            record.asset?.dispose();
        }
        this.updateBounds();
        this.scene.notifySceneChange();
        this.onChange();
    }

    private updateBounds() {
        this.bounds.makeEmpty();
        for (const record of this.records) {
            if (record.asset) {
                this.bounds.union(record.asset.bounds);
            }
        }
        this.control.setOrbitCenter(this.bounds.isEmpty() ? new Vector3() : this.bounds.getCenter(new Vector3()));
    }

    frameModels() {
        if (this.bounds.isEmpty()) {
            return;
        }
        const center = this.bounds.getCenter(new Vector3());
        const radius = Math.max(this.bounds.getSize(new Vector3()).length() / 2, 0.01);
        const verticalFov = (this.camera.fov * Math.PI) / 360;
        const halfFov = Math.min(verticalFov, Math.atan(Math.tan(verticalFov) * this.camera.aspect));
        const distance = (radius / Math.sin(halfFov)) * 1.15;
        const direction = this.camera.getWorldDirection(new Vector3()).multiplyScalar(-1);
        this.camera.position.copy(center).addScaledVector(direction, distance);
        this.camera.lookAt(center);
        this.camera.far = Math.max(this.camera.far, distance + radius * 4);
        this.camera.updateProjectionMatrix();
        this.control.setOrbitCenter(center);
        this.control.stop();
        this.onChange();
    }

    setCoordinateSystem(value: CoordinateSystem) {
        this.coordinateSystem = value;
        if (value === 'aholo') {
            this.camera.up.set(0, 0, 1);
            this.camera.position.set(0, 0, 0.1);
        } else if (value === 'opengl') {
            this.camera.up.set(0, 1, 0);
            this.camera.position.set(0, 0.1, 0);
        } else {
            this.camera.up.set(0, -1, 0);
            this.camera.position.set(0, -0.1, 0);
        }
        this.camera.lookAt(this.camera.position.clone().add(new Vector3(1, 0, 0)));
        this.control.stop();
    }

    copyCameraFrom(source: ViewerScene) {
        this.camera.position.copy(source.camera.position);
        this.camera.quaternion.copy(source.camera.quaternion);
        this.camera.up.copy(source.camera.up);
        this.camera.fov = source.camera.fov;
        this.camera.near = source.camera.near;
        this.camera.far = source.camera.far;
        this.camera.updateProjectionMatrix();
        this.coordinateSystem = source.coordinateSystem;
        this.control.setOrbitCenter(source.control.getState().orbitCenter);
    }

    resize() {
        if (this.destroyed || this.contextLost || !this.surface.clientWidth || !this.surface.clientHeight) {
            return;
        }
        this.viewer.resize();
        syncCameraAspect(this.camera, this.viewer);
    }

    render() {
        if (this.destroyed || this.contextLost) {
            return;
        }
        for (const record of this.records) {
            record.asset?.lod?.tick(this.camera);
        }
        this.viewer.render();
    }

    private onContextLost = () => {
        if (this.contextLost || this.destroyed) {
            return;
        }
        this.contextLost = true;
        this.control.stop();
        this.control.enabled = false;
        for (const record of this.records) {
            record.controller.abort();
        }
        this.onChange();
    };

    dispose() {
        this.destroyed = true;
        this.surface.removeEventListener('webglcontextlost', this.onContextLost, true);
        this.control.dispose();
        this.clear();
        this.viewer.destroy();
    }
}
