import type { Camera3D, Viewer } from '@manycore/aholo-viewer';

export function getViewerCanvas(viewer: Viewer, message = 'The renderer did not create a canvas.') {
    const canvas = viewer.canvasContainer.querySelector('canvas');

    if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error(message);
    }

    return canvas;
}

export function styleRendererCanvas(canvas: HTMLCanvasElement) {
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.minHeight = '0';
    canvas.style.outline = 'none';
}

export function syncCameraAspect(camera: Camera3D, viewer: Viewer) {
    if (!('aspect' in camera)) {
        return;
    }

    const { width, height } = viewer.getSize();
    const aspect = width > 0 && height > 0 ? width / height : 1;
    const perspectiveCamera = camera as Camera3D & {
        aspect: number;
        updateProjectionMatrix?: () => void;
    };

    if (Number.isFinite(aspect) && Math.abs(perspectiveCamera.aspect - aspect) > 0.001) {
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix?.();
    }
}

export function countSceneObjects(scene: unknown) {
    let count = 0;

    function visit(node: unknown) {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node !== scene && isRenderableSceneObject(node)) {
            count += 1;
        }

        if ('children' in node && Array.isArray(node.children)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    }

    visit(scene);
    return count;
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal, abortMessage: string): Promise<T> {
    throwIfAborted(signal, abortMessage);

    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            reject(createAbortError(abortMessage));
        };

        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}

export function throwIfAborted(signal: AbortSignal, abortMessage: string) {
    if (signal.aborted) {
        throw createAbortError(abortMessage);
    }
}

export function createAbortError(abortMessage: string) {
    return new DOMException(abortMessage, 'AbortError');
}

function isRenderableSceneObject(node: object) {
    return (
        ('isMesh' in node && node.isMesh === true) ||
        ('isSplat' in node && node.isSplat === true) ||
        ('isSprite' in node && node.isSprite === true) ||
        ('isPoints' in node && node.isPoints === true) ||
        ('isLine' in node && node.isLine === true)
    );
}
