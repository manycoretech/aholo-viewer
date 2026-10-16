/** Camera-local axes used by the renderer; presets only select the world's up direction. */
interface CameraPoseSource {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
}

interface CameraPoseCopyOptions {
    root: ParentNode;
    getCamera: () => CameraPoseSource;
    getWorldUpPreset: () => string;
    hasLoadedFiles: () => boolean;
    labels: { copiedPose: string; poseNoFile: string };
    onError: (error: unknown) => void;
}

export const CAMERA_POSE_TOAST_DURATION_MS = 3000;

/**
 * Copy the renderer's camera-to-world pose without changing its basis or numeric values.
 * `coordinateSystem` is a legacy alias for `worldUpPreset`, not a camera-axis convention.
 */
export function serializeCameraPose(camera: CameraPoseSource, worldUpPreset: string) {
    return {
        type: 'camera-pose',
        convention: 'camera-to-world',
        coordinateSystem: worldUpPreset,
        worldUpPreset,
        cameraAxes: { right: '+X', up: '+Y', forward: '-Z' },
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        quaternion: {
            x: camera.quaternion.x,
            y: camera.quaternion.y,
            z: camera.quaternion.z,
            w: camera.quaternion.w,
        },
    };
}

export function mountCameraPoseCopy(options: CameraPoseCopyOptions) {
    const button = query<HTMLButtonElement>('[data-camera-pose-copy]');
    const toast = query<HTMLElement>('[data-pose-toast]');
    const message = query<HTMLElement>('[data-pose-toast-message]');
    const close = query<HTMLButtonElement>('[data-pose-toast-close]');
    let disposed = false;
    let revision = 0;
    let timer: number | undefined;
    let pendingWrite: Promise<void> | undefined;

    toast.style.setProperty('--viewer-pose-toast-duration', `${CAMERA_POSE_TOAST_DURATION_MS}ms`);
    button.addEventListener('click', handleCopy);
    close.addEventListener('click', dismiss);

    function query<T extends HTMLElement>(selector: string) {
        const element = options.root.querySelector<T>(selector);
        if (!element) {
            throw new Error(`Missing camera pose element: ${selector}`);
        }
        return element;
    }

    function hideToast() {
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timer = undefined;
        }
        toast.dataset.visible = 'false';
    }

    function dismiss() {
        revision += 1;
        hideToast();
    }

    function showToast(state: 'success' | 'error', text: string) {
        hideToast();
        toast.dataset.state = state;
        message.textContent = text;
        // Restart the single notification's animation after repeated clicks.
        void toast.offsetWidth;
        toast.dataset.visible = 'true';
        timer = window.setTimeout(hideToast, CAMERA_POSE_TOAST_DURATION_MS);
    }

    async function handleCopy() {
        const requestRevision = ++revision;
        hideToast();
        if (!options.hasLoadedFiles()) {
            showToast('error', options.labels.poseNoFile);
            return;
        }

        try {
            const pose = serializeCameraPose(options.getCamera(), options.getWorldUpPreset());
            const text = JSON.stringify(pose);
            // Start the first write in the click handler to retain user activation.
            // Later snapshots wait for it so an older write cannot overwrite them.
            const write = pendingWrite
                ? pendingWrite.then(() => (disposed ? undefined : navigator.clipboard.writeText(text)))
                : navigator.clipboard.writeText(text);
            const settled = write.then(
                () => {},
                () => {},
            );
            pendingWrite = settled;
            void settled.then(() => {
                if (pendingWrite === settled) {
                    pendingWrite = undefined;
                }
            });
            await write;
            if (!disposed && requestRevision === revision) {
                showToast('success', options.labels.copiedPose);
            }
        } catch (error) {
            if (!disposed && requestRevision === revision) {
                options.onError(error);
            }
        }
    }

    return {
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            dismiss();
            button.removeEventListener('click', handleCopy);
            close.removeEventListener('click', dismiss);
        },
    };
}
