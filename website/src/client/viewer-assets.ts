import {
    Animation,
    Box3,
    GLTFLoader,
    SplatLoader,
    SplatUtils,
    TypeAssert,
    Vector3,
    downloadTexture,
    type Object3D,
    type Viewer,
} from '@manycore/aholo-viewer';
import type { ViewerLabels } from './viewer-labels.js';

export const SPLAT_EXTENSIONS = ['.ply', '.spz', '.splat', '.ksplat', '.zip', '.sog', '.esz', '.json'];
export const MODEL_EXTENSIONS = [...SPLAT_EXTENSIONS, '.gltf', '.glb'];

export type AssetSource =
    | { kind: 'file'; name: string; file: File; path: string; files: ReadonlyMap<string, File> }
    | { kind: 'url'; name: string; url: string };

export interface LoadedAsset {
    object: Object3D;
    bounds: Box3;
    format: string;
    splatCount?: number;
    shDegree?: number;
    meshCount?: number;
    lod?: InstanceType<typeof SplatUtils.LodSplat>;
    dispose(): void;
}

export function fileSources(files: readonly { file: File; path: string }[]): AssetSource[] {
    const resources = new Map(files.map(({ file, path }) => [normalizePath(path), file]));
    const hasGltf = files.some(({ path }) => /\.(gltf|glb)$/iu.test(path));
    return files
        .filter(({ path }) => !hasGltf || MODEL_EXTENSIONS.includes(extension(path)))
        .map(({ file, path }) => ({
            kind: 'file',
            name: file.name,
            file,
            path: normalizePath(path),
            files: resources,
        }));
}

export function urlSources(text: string): AssetSource[] {
    return text
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map(value => {
            const url = new URL(value, window.location.href);
            if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) {
                throw new Error(`Unsupported URL: ${value}`);
            }
            return {
                kind: 'url',
                name: decodeURIComponent(url.pathname.split('/').pop() || url.hostname),
                url: url.href,
            };
        });
}

export async function droppedFiles(transfer: DataTransfer) {
    const entries = Array.from(transfer.items)
        .map(item => item.webkitGetAsEntry?.())
        .filter(entry => entry !== null);
    if (!entries.length) {
        return Array.from(transfer.files, file => ({ file, path: file.webkitRelativePath || file.name }));
    }
    const files: { file: File; path: string }[] = [];
    async function visit(entry: FileSystemEntry) {
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) =>
                (entry as FileSystemFileEntry).file(resolve, reject),
            );
            files.push({ file, path: entry.fullPath.replace(/^\//u, '') });
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            while (true) {
                const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                    reader.readEntries(resolve, reject),
                );
                if (!children.length) {
                    break;
                }
                for (const child of children) {
                    await visit(child);
                }
            }
        }
    }
    for (const entry of entries) {
        await visit(entry);
    }
    return files;
}

export function extension(name: string) {
    return (
        name
            .split(/[?#]/u)[0]
            .match(/\.[^./]+$/u)?.[0]
            .toLowerCase() ?? ''
    );
}

async function readSource(source: AssetSource, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    if (source.kind === 'file') {
        return source.file.arrayBuffer();
    }
    const response = await fetch(source.url, { signal });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${source.url}`);
    }
    return response.arrayBuffer();
}

export async function inspectSplatSource(source: AssetSource, signal: AbortSignal) {
    const ext = extension(source.name);
    const content = ext === '.zip' || ext === '.json' ? new Uint8Array(await readSource(source, signal)) : undefined;
    signal.throwIfAborted();
    const json: unknown = ext === '.json' ? JSON.parse(new TextDecoder().decode(content)) : undefined;
    if (isLodMeta(json)) {
        return { lod: json };
    }
    const probe =
        content ??
        (source.kind === 'file' ? new Uint8Array(await source.file.slice(0, 4096).arrayBuffer()) : new Uint8Array());
    const type = SplatLoader.detectSplatFileType(source.name.toLowerCase(), probe);
    if (type === undefined) {
        throw new Error(`Unsupported file type: ${source.name}`);
    }
    return { type, input: content ?? (source.kind === 'file' ? source.file : source.url) };
}

function isLodMeta(value: unknown): value is SplatUtils.LodMeta {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const meta = value as Partial<SplatUtils.LodMeta>;
    return (
        meta.magicCode === 0x262834 &&
        meta.type === 'lod-splat' &&
        typeof meta.counts === 'number' &&
        typeof meta.levels === 'number' &&
        Array.isArray(meta.files) &&
        Array.isArray(meta.tree)
    );
}

export function splatBounds(data: SplatLoader.SplatData) {
    const bounds = new Box3();
    if (data instanceof SplatLoader.SogSplatData) {
        const { means } = data.serialize().extras![0];
        const decode = (value: number) => Math.sign(value) * Math.expm1(Math.abs(value));
        bounds.min.fromArray(means.mins.map(decode));
        bounds.max.fromArray(means.maxs.map(decode));
    } else {
        const center = { x: 0, y: 0, z: 0 } as SplatLoader.ISingleSplat;
        const point = new Vector3();
        for (let i = 0; i < data.counts; i++) {
            data.getCenter(i, center);
            if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
                bounds.expandByPoint(point.set(center.x, center.y, center.z));
            }
        }
    }
    return bounds;
}

export async function createStreamedSplat(data: SplatLoader.SplatData, viewer: Viewer) {
    type Renderer = NonNullable<Parameters<typeof SplatUtils.createSplat>[1]> & {
        rendererStatus: { initialized: Promise<void> };
    };
    // gs-viewer uses this host hook; the bundled Viewer strips it from public declarations.
    const renderer = (viewer as Viewer & { _getEngine(): { renderer: Renderer } })._getEngine().renderer;
    const readChunks = data.readChunks;
    let bounds: Box3;
    try {
        await renderer.rendererStatus.initialized;
        data.signal?.throwIfAborted();
        if (data instanceof SplatLoader.SogSplatData) {
            bounds = splatBounds(data);
        } else {
            bounds = new Box3();
            const header = data.serialize();
            const decoder =
                data instanceof SplatLoader.CompressedSplatData
                    ? new SplatLoader.CompressedSplatData()
                    : new SplatLoader.SuperCompressedSplatData();
            // Observe each center chunk before the uploader releases its buffer; never collect the full stream.
            data.readChunks = (consume, release) =>
                readChunks.call(
                    data,
                    async chunk => {
                        const centers = chunk.samplers.find(sampler => sampler.index === 0);
                        if (centers) {
                            const counts = Math.min(centers.source.byteLength / 16, data.counts - centers.offset / 16);
                            decoder.deserialize({
                                ...header,
                                counts,
                                samplers: header.samplers.map((sampler, index) =>
                                    index === 0
                                        ? {
                                              ...sampler,
                                              // SDK decoders address the underlying buffer from byte zero.
                                              source: centers.source.byteOffset
                                                  ? centers.source.slice()
                                                  : centers.source,
                                          }
                                        : sampler,
                                ),
                            });
                            bounds.union(splatBounds(decoder));
                        }
                        await consume(chunk);
                    },
                    release,
                );
        }
        const object = await SplatUtils.createSplat(data, renderer);
        return { object, bounds };
    } catch (error) {
        data.cancel(error);
        throw error;
    } finally {
        data.readChunks = readChunks;
    }
}

export function lodBounds(meta: SplatUtils.LodMeta) {
    const bounds = new Box3();
    const point = new Vector3();
    for (const { bound } of meta.tree) {
        bounds.expandByPoint(point.fromArray(bound.min));
        bounds.expandByPoint(point.fromArray(bound.max));
    }
    return bounds;
}

interface GltfDocument {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
    extensionsRequired?: string[];
}

const GLTF_EXTENSIONS = new Set(['KHR_texture_transform', 'KHR_materials_unlit', 'KHR_animation_pointer']);

export async function loadGltfAsset(
    source: AssetSource,
    signal: AbortSignal,
    labels: ViewerLabels,
): Promise<LoadedAsset> {
    const urls = new Set<string>();
    const textures = new Set<Awaited<ReturnType<typeof downloadTexture>>>();
    let parsed: GLTFLoader.ParseResult | undefined;
    let animation: InstanceType<typeof Animation.AnimationPlugin> | undefined;
    const skeletons: InstanceType<typeof Animation.Skeleton>[] = [];
    const dispose = () => {
        if (animation) {
            animation.destroy();
        }
        for (const skeleton of skeletons) {
            skeleton.texture.destroy();
        }
        for (const scene of parsed?.scenes ?? []) {
            disposeObject(scene);
        }
        for (const texture of textures) {
            texture.destroy();
        }
    };
    const resolveUri = (uri: string) => {
        if (/^(data:|blob:|https?:)/iu.test(uri)) {
            return uri;
        }
        if (source.kind === 'url') {
            return new URL(uri, source.url).href;
        }
        const relative = normalizePath(new URL(uri, `https://local.invalid/${source.path}`).pathname);
        let file = source.files.get(relative);
        if (!file) {
            // Flat multi-file selection does not expose directory paths. Accept a unique basename.
            const basename = decodeURIComponent(uri.split('/').pop()!.split(/[?#]/u)[0]);
            const matches = [...source.files.values()].filter(value => value.name === basename);
            if (matches.length === 1) {
                file = matches[0];
            }
        }
        if (!file) {
            throw new Error(`${labels.missingResource}: ${uri}`);
        }
        const url = URL.createObjectURL(file);
        urls.add(url);
        return url;
    };
    try {
        const buffer = await readSource(source, signal);
        let input: ArrayBuffer | string = buffer;
        if (extension(source.name) === '.gltf') {
            const document = JSON.parse(new TextDecoder().decode(buffer)) as GltfDocument;
            const unsupported = document.extensionsRequired?.filter(value => !GLTF_EXTENSIONS.has(value));
            if (unsupported?.length) {
                throw new Error(`${labels.unsupportedGltf}: ${unsupported.join(', ')}`);
            }
            for (const item of document.buffers ?? []) {
                if (!item.uri) {
                    continue;
                }
                const response = await fetch(resolveUri(item.uri), { signal });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${item.uri}`);
                }
                item.uri = await bufferDataUri(await response.arrayBuffer());
            }
            for (const image of document.images ?? []) {
                if (image.uri) {
                    image.uri = resolveUri(image.uri);
                }
            }
            input = JSON.stringify(document);
        }
        signal.throwIfAborted();
        parsed = await GLTFLoader.loadGLTF(input, {
            textureLoader: async uri => {
                signal.throwIfAborted();
                const resolved = resolveUri(uri);
                if (resolved.startsWith('blob:')) {
                    urls.add(resolved);
                }
                const texture = await downloadTexture(resolved);
                textures.add(texture);
                return texture;
            },
        });
        signal.throwIfAborted();
        if (parsed.skeletons.size) {
            animation = new Animation.AnimationPlugin();
            const mixer = new Animation.AnimationMixer(parsed.scene);
            animation.add(mixer);
            for (const [definition, meshes] of parsed.skeletons) {
                const skeleton = new Animation.Skeleton(definition.bones, definition.inverseBindMatrices);
                skeletons.push(skeleton);
                for (const mesh of meshes) {
                    animation.bindSkinned(mesh, skeleton, mixer);
                }
            }
            animation.beforeRendering();
        }
        const object = parsed.scene;
        let meshCount = 0;
        object.traverse(child => {
            if (TypeAssert.isMesh(child)) {
                meshCount++;
            }
        });
        const bounds = object.getLocalBounds().applyMatrix4(object.matrixWorld);
        return { object, bounds, format: extension(source.name).slice(1).toUpperCase(), meshCount, dispose };
    } catch (error) {
        dispose();
        throw error;
    } finally {
        for (const url of urls) {
            URL.revokeObjectURL(url);
        }
    }
}

function bufferDataUri(buffer: ArrayBuffer): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([buffer], { type: 'application/octet-stream' }));
    });
}

export function disposeObject(object: Object3D) {
    object.removeFromParent();
    object.traverse(child => child.destroyAllResourcesOwned());
    object.destroy();
}

function normalizePath(path: string) {
    return decodeURIComponent(path)
        .replace(/\\/gu, '/')
        .replace(/^\/+|[?#].*$/gu, '');
}

export function formatBytes(bytes: number | undefined) {
    if (bytes === undefined) {
        return '—';
    }
    const unit = Math.min(Math.floor(Math.log2(Math.max(1, bytes)) / 10), 3);
    return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}
