import type { CameraControl, CameraControlCamera } from './camera-control.js';
import { CameraRotationGizmo, type CameraRotationAxisLabels } from './camera-rotation-gizmo.js';

interface CameraRotationOptions {
    root: HTMLElement;
    container: HTMLElement;
    camera: CameraControlCamera;
    control: CameraControl;
    labels: CameraRotationAxisLabels;
    onChange: () => void;
}

/** Own the Viewer-only rotation toggle, overlay, and temporary orbit suppression. */
export function mountCameraRotation(options: CameraRotationOptions) {
    const input = options.root.querySelector<HTMLInputElement>('[data-camera-rotation]');
    if (!input) {
        throw new Error('Missing camera rotation toggle.');
    }
    const toggle = input;

    const orbitEnabled = options.control.orbitEnabled;
    const gizmo = new CameraRotationGizmo(options.container, options);
    let disposed = false;

    function sync() {
        // useOrbit keeps its shared position-orbit meaning. Disable that path
        // (including Alt) while the Viewer requests in-place local rotation.
        options.control.stop();
        options.control.setOptions({ orbitEnabled: toggle.checked ? false : orbitEnabled });
        gizmo.setEnabled(toggle.checked);
        options.onChange();
    }

    input.addEventListener('change', sync);
    sync();

    return {
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            input.removeEventListener('change', sync);
            gizmo.dispose();
            options.control.setOptions({ orbitEnabled });
        },
    };
}
