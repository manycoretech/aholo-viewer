interface CameraControlVector3 {
    x: number;
    y: number;
    z: number;
}

interface CameraControlEuler extends CameraControlVector3 {
    order?: string;
    set?: (x: number, y: number, z: number, order?: string) => unknown;
}

interface CameraControlQuaternion extends CameraControlVector3 {
    w: number;
}

interface CameraControlMatrix4 {
    _elements: Float32Array;
}

interface CameraControlCamera {
    position: CameraControlVector3;
    rotation: CameraControlEuler;
    up?: CameraControlVector3;
    quaternion?: CameraControlQuaternion;
}

interface CameraControlOptions {
    enabled?: boolean;
    keyboardEnabled?: boolean;
    pointerEnabled?: boolean;
    orbitEnabled?: boolean;
    useOrbit?: boolean;
    orbitCenter?: CameraControlVector3;
    orbitMinDistance?: number;
    moveSpeed?: number;
    lookSpeed?: number;
    wheelSpeed?: number;
    panSpeed?: number;
    rollSpeed?: number;
    shiftMultiplier?: number;
    ctrlMultiplier?: number;
    capsMultiplier?: number;
}

interface CameraControlState {
    position: CameraControlVector3;
    rotation: CameraControlVector3;
    moving: boolean;
    rotating: boolean;
    panning: boolean;
    orbiting: boolean;
    touching: boolean;
    interacting: boolean;
    speedMultiplier: number;
    activePointers: number;
    orbitCenter: CameraControlVector3;
    orbitDistance: number;
}

type PointerMode = 'rotate' | 'pan' | 'orbit';

interface PointerTrack {
    pointerId: number;
    pointerType: string;
    button: number;
    mode: PointerMode;
    lastX: number;
    lastY: number;
    x: number;
    y: number;
}

const DEFAULT_OPTIONS: Required<CameraControlOptions> = {
    enabled: true,
    keyboardEnabled: true,
    pointerEnabled: true,
    orbitEnabled: true,
    useOrbit: false,
    orbitCenter: { x: 0, y: 0, z: 0 },
    orbitMinDistance: 0.01,
    moveSpeed: 0.4,
    lookSpeed: 0.004,
    wheelSpeed: 0.006,
    panSpeed: 0.006,
    rollSpeed: 1,
    ctrlMultiplier: 2,
    shiftMultiplier: 10,
    capsMultiplier: 20,
};

const KEYBOARD_CONTROL_KEYS = new Set([
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyQ',
    'KeyE',
    'KeyR',
    'KeyF',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'CapsLock',
]);

const MAX_PITCH = Math.PI / 2 - 0.001;
const EPSILON = 1e-6;
const DEFAULT_UP: CameraControlVector3 = { x: 0, y: 1, z: 0 };
const DEFAULT_ORBIT_CENTER: CameraControlVector3 = { x: 0, y: 0, z: 0 };

/**
 * Lightweight free-flight camera controls for website and Playground preview surfaces.
 */
export class CameraControl {
    enabled: boolean;
    keyboardEnabled: boolean;
    pointerEnabled: boolean;
    orbitEnabled: boolean;
    useOrbit: boolean;
    orbitMinDistance: number;
    moveSpeed: number;
    lookSpeed: number;
    wheelSpeed: number;
    panSpeed: number;
    rollSpeed: number;
    shiftMultiplier: number;
    ctrlMultiplier: number;
    capsMultiplier: number;

    readonly #camera: CameraControlCamera;
    readonly #element: HTMLElement;
    readonly #pointers = new Map<number, PointerTrack>();
    readonly #keys = new Set<string>();
    readonly #orbitCenter = copyVector(DEFAULT_ORBIT_CENTER);
    readonly #initialTabIndex: string | null;
    readonly #initialTouchAction: string;
    #lastTime = 0;
    #wheelDelta = 0;
    #capsLock = false;
    #altKey = false;
    #moving = false;
    #rotating = false;
    #panning = false;
    #orbiting = false;
    #disposed = false;

    constructor(camera: CameraControlCamera, element: HTMLElement, options: CameraControlOptions = {}) {
        this.#camera = camera;
        this.#element = element;
        this.#initialTabIndex = element.getAttribute('tabindex');
        this.#initialTouchAction = element.style.touchAction;

        const resolved = {
            ...DEFAULT_OPTIONS,
            ...options,
        };

        this.enabled = resolved.enabled;
        this.keyboardEnabled = resolved.keyboardEnabled;
        this.pointerEnabled = resolved.pointerEnabled;
        this.orbitEnabled = resolved.orbitEnabled;
        this.useOrbit = resolved.useOrbit;
        this.orbitMinDistance = Math.max(EPSILON, resolved.orbitMinDistance);
        this.setOrbitCenter(resolved.orbitCenter);
        this.moveSpeed = resolved.moveSpeed;
        this.lookSpeed = resolved.lookSpeed;
        this.wheelSpeed = resolved.wheelSpeed;
        this.panSpeed = resolved.panSpeed;
        this.rollSpeed = resolved.rollSpeed;
        this.shiftMultiplier = resolved.shiftMultiplier;
        this.ctrlMultiplier = resolved.ctrlMultiplier;
        this.capsMultiplier = resolved.capsMultiplier;

        if (this.#initialTabIndex === null) {
            element.tabIndex = 0;
        }

        element.style.touchAction = 'none';
        element.addEventListener('pointerdown', this.#onPointerDown);
        element.addEventListener('pointermove', this.#onPointerMove);
        element.addEventListener('pointerup', this.#onPointerUp);
        element.addEventListener('pointercancel', this.#onPointerUp);
        element.addEventListener('contextmenu', this.#onContextMenu);
        element.addEventListener('wheel', this.#onWheel, { passive: false });
        element.addEventListener('keydown', this.#onKeyDown);
        element.addEventListener('keyup', this.#onKeyUp);
        window.addEventListener('keyup', this.#onKeyUp);
        window.addEventListener('blur', this.#onBlur);
    }

    setOptions(options: CameraControlOptions) {
        const { orbitCenter, ...rest } = options;

        if (orbitCenter !== undefined) {
            this.setOrbitCenter(orbitCenter);
        }

        for (const [key, value] of Object.entries(rest)) {
            if (value !== undefined) {
                if (key === 'orbitMinDistance' && typeof value === 'number') {
                    this.orbitMinDistance = Math.max(EPSILON, value);
                } else {
                    (this as unknown as Record<string, unknown>)[key] = value;
                }
            }
        }
    }

    setOrbitCenter(center: CameraControlVector3) {
        this.#orbitCenter.x = center.x;
        this.#orbitCenter.y = center.y;
        this.#orbitCenter.z = center.z;
    }

    stop() {
        for (const pointer of this.#pointers.values()) {
            if (this.#element.hasPointerCapture(pointer.pointerId)) {
                this.#element.releasePointerCapture(pointer.pointerId);
            }
        }

        this.#keys.clear();
        this.#pointers.clear();
        this.#wheelDelta = 0;
        this.#altKey = false;
        this.#moving = false;
        this.#rotating = false;
        this.#panning = false;
        this.#orbiting = false;
    }

    update(deltaSeconds?: number) {
        if (this.#disposed || !this.enabled) {
            return false;
        }

        const now = performance.now();
        const delta = deltaSeconds ?? Math.min((now - (this.#lastTime || now)) / 1000, 0.1);
        this.#lastTime = now;

        const pointerChanged = this.pointerEnabled ? this.#updatePointers() : false;
        const keyboardChanged = this.keyboardEnabled ? this.#updateKeyboard(delta) : false;
        const wheelChanged = this.pointerEnabled ? this.#updateWheel() : false;

        return pointerChanged || keyboardChanged || wheelChanged;
    }

    getState(): CameraControlState {
        const position = this.#camera.position;
        const rotation = this.#camera.rotation;
        const touching = Array.from(this.#pointers.values()).some(pointer => pointer.pointerType === 'touch');
        const interacting =
            this.#moving || this.#rotating || this.#panning || this.#orbiting || this.#pointers.size > 0;

        return {
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
            moving: this.#moving,
            rotating: this.#rotating,
            panning: this.#panning,
            orbiting: this.#orbiting,
            touching,
            interacting,
            speedMultiplier: this.#getSpeedMultiplier(),
            activePointers: this.#pointers.size,
            orbitCenter: copyVector(this.#orbitCenter),
            orbitDistance: this.#getOrbitDistance(),
        };
    }

    dispose() {
        if (this.#disposed) {
            return;
        }

        this.stop();
        this.#disposed = true;
        this.#element.removeEventListener('pointerdown', this.#onPointerDown);
        this.#element.removeEventListener('pointermove', this.#onPointerMove);
        this.#element.removeEventListener('pointerup', this.#onPointerUp);
        this.#element.removeEventListener('pointercancel', this.#onPointerUp);
        this.#element.removeEventListener('contextmenu', this.#onContextMenu);
        this.#element.removeEventListener('wheel', this.#onWheel);
        this.#element.removeEventListener('keydown', this.#onKeyDown);
        this.#element.removeEventListener('keyup', this.#onKeyUp);
        window.removeEventListener('keyup', this.#onKeyUp);
        window.removeEventListener('blur', this.#onBlur);
        this.#element.style.touchAction = this.#initialTouchAction;

        if (this.#initialTabIndex === null) {
            this.#element.removeAttribute('tabindex');
        } else {
            this.#element.setAttribute('tabindex', this.#initialTabIndex);
        }
    }

    #onPointerDown = (event: PointerEvent) => {
        if (!this.enabled || !this.pointerEnabled) {
            return;
        }

        this.#element.focus({ preventScroll: true });
        this.#altKey = event.altKey;
        this.#pointers.set(event.pointerId, {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            button: event.button,
            mode: this.#getPointerMode(event.pointerType, event.button),
            lastX: event.clientX,
            lastY: event.clientY,
            x: event.clientX,
            y: event.clientY,
        });
        this.#element.setPointerCapture(event.pointerId);
        event.preventDefault();
    };

    #onPointerMove = (event: PointerEvent) => {
        const pointer = this.#pointers.get(event.pointerId);

        if (!pointer) {
            return;
        }

        this.#altKey = event.altKey;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        event.preventDefault();
    };

    #onPointerUp = (event: PointerEvent) => {
        if (this.#pointers.has(event.pointerId)) {
            this.#pointers.delete(event.pointerId);

            if (this.#element.hasPointerCapture(event.pointerId)) {
                this.#element.releasePointerCapture(event.pointerId);
            }

            if (this.#pointers.size === 0) {
                this.#rotating = false;
                this.#panning = false;
                this.#orbiting = false;
            }
        }
    };

    #onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
    };

    #onWheel = (event: WheelEvent) => {
        if (!this.enabled || !this.pointerEnabled) {
            return;
        }

        this.#wheelDelta += event.deltaY;
        event.preventDefault();
    };

    #onKeyDown = (event: KeyboardEvent) => {
        if (!this.enabled || !this.keyboardEnabled || !KEYBOARD_CONTROL_KEYS.has(event.code)) {
            return;
        }

        this.#keys.add(event.code);
        this.#capsLock = event.getModifierState('CapsLock');
        this.#altKey = event.altKey || event.code === 'AltLeft' || event.code === 'AltRight';
        event.preventDefault();
    };

    #onKeyUp = (event: KeyboardEvent) => {
        this.#keys.delete(event.code);
        this.#capsLock = event.getModifierState('CapsLock');
        this.#altKey = event.altKey;
    };

    #onBlur = () => {
        this.stop();
    };

    #updatePointers() {
        const pointers = Array.from(this.#pointers.values());
        this.#rotating = false;
        this.#panning = false;
        this.#orbiting = false;

        if (pointers.length === 0) {
            return false;
        }

        let updated = false;

        if (pointers.length >= 2) {
            const first = pointers[0];
            const second = pointers[1];
            const lastMidX = (first.lastX + second.lastX) * 0.5;
            const lastMidY = (first.lastY + second.lastY) * 0.5;
            const midX = (first.x + second.x) * 0.5;
            const midY = (first.y + second.y) * 0.5;
            const lastDistance = distance(first.lastX, first.lastY, second.lastX, second.lastY);
            const currentDistance = distance(first.x, first.y, second.x, second.y);
            const panX = midX - lastMidX;
            const panY = midY - lastMidY;
            const pinch = currentDistance - lastDistance;

            updated = this.#panByPixels(panX, panY) || updated;
            updated = this.#moveAlongView(pinch * this.wheelSpeed) || updated;
            this.#panning = Math.abs(panX) + Math.abs(panY) + Math.abs(pinch) > 0.001;
        } else {
            const pointer = pointers[0];
            const mode = this.#getPointerMode(pointer.pointerType, pointer.button);

            if (pointer.mode !== mode) {
                pointer.mode = mode;
                pointer.lastX = pointer.x;
                pointer.lastY = pointer.y;
            }

            const deltaX = pointer.x - pointer.lastX;
            const deltaY = pointer.y - pointer.lastY;

            if (mode === 'pan') {
                updated = this.#panByPixels(deltaX, deltaY);
                this.#panning = updated;
            } else if (mode === 'orbit') {
                updated = this.#orbitByPixels(deltaX, deltaY);
                this.#orbiting = true;
            } else {
                updated = this.#rotateByPixels(deltaX, deltaY);
                this.#rotating = updated;
            }
        }

        for (const pointer of pointers) {
            pointer.lastX = pointer.x;
            pointer.lastY = pointer.y;
        }

        return updated;
    }

    #updateKeyboard(deltaSeconds: number) {
        const forwardInput = numberFromKey(this.#keys, 'KeyW') - numberFromKey(this.#keys, 'KeyS');
        const strafeInput = numberFromKey(this.#keys, 'KeyD') - numberFromKey(this.#keys, 'KeyA');
        const verticalInput = numberFromKey(this.#keys, 'KeyQ') - numberFromKey(this.#keys, 'KeyE');
        const rollInput = numberFromKey(this.#keys, 'KeyR') - numberFromKey(this.#keys, 'KeyF');
        const multiplier = this.#getSpeedMultiplier();
        let updated = false;

        const movementLength = Math.hypot(forwardInput, strafeInput, verticalInput);
        this.#moving = movementLength > 0;

        if (movementLength > 0) {
            const scale = (this.moveSpeed * multiplier * deltaSeconds) / Math.max(1, movementLength);
            const basis = getCameraBasis(this.#camera);
            const position = this.#camera.position;

            position.x +=
                (basis.forward.x * forwardInput + basis.right.x * strafeInput + basis.up.x * verticalInput) * scale;
            position.y +=
                (basis.forward.y * forwardInput + basis.right.y * strafeInput + basis.up.y * verticalInput) * scale;
            position.z +=
                (basis.forward.z * forwardInput + basis.right.z * strafeInput + basis.up.z * verticalInput) * scale;
            updated = true;
        }

        if (rollInput !== 0) {
            rollCamera(this.#camera, rollInput * this.rollSpeed * deltaSeconds);
            this.#rotating = true;
            updated = true;
        } else if (this.#pointers.size === 0) {
            this.#rotating = false;
        }

        return updated;
    }

    #updateWheel() {
        if (Math.abs(this.#wheelDelta) < 0.001) {
            return false;
        }

        const delta = -this.#wheelDelta * this.wheelSpeed;
        this.#wheelDelta = 0;
        return this.#moveAlongView(delta);
    }

    #rotateByPixels(deltaX: number, deltaY: number) {
        if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
            return false;
        }

        rotateCamera(this.#camera, -deltaX * this.lookSpeed, -deltaY * this.lookSpeed);
        return true;
    }

    #orbitByPixels(deltaX: number, deltaY: number) {
        if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
            return false;
        }

        return orbitCamera(
            this.#camera,
            this.#orbitCenter,
            -deltaX * this.lookSpeed,
            -deltaY * this.lookSpeed,
            this.orbitMinDistance,
        );
    }

    #panByPixels(deltaX: number, deltaY: number) {
        if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
            return false;
        }

        const basis = getCameraBasis(this.#camera);
        const position = this.#camera.position;
        const x = deltaX * this.panSpeed;
        const y = -deltaY * this.panSpeed;

        position.x += basis.right.x * x + basis.viewUp.x * y;
        position.y += basis.right.y * x + basis.viewUp.y * y;
        position.z += basis.right.z * x + basis.viewUp.z * y;
        return true;
    }

    #moveAlongView(distanceValue: number) {
        if (Math.abs(distanceValue) < 0.001) {
            return false;
        }

        const forward = getCameraBasis(this.#camera).forward;
        const position = this.#camera.position;
        position.x += forward.x * distanceValue;
        position.y += forward.y * distanceValue;
        position.z += forward.z * distanceValue;
        return true;
    }

    #getSpeedMultiplier() {
        let multiplier = 1;

        if (this.#keys.has('ShiftLeft') || this.#keys.has('ShiftRight')) {
            multiplier *= this.shiftMultiplier;
        }

        if (this.#keys.has('ControlLeft') || this.#keys.has('ControlRight')) {
            multiplier *= this.ctrlMultiplier;
        }

        if (this.#capsLock || this.#keys.has('CapsLock')) {
            multiplier *= this.capsMultiplier;
        }

        return multiplier;
    }

    #getPointerMode(pointerType: string, button: number): PointerMode {
        if (pointerType === 'mouse') {
            if (button === 1 || button === 2) {
                return 'pan';
            }

            if (button === 0 && this.orbitEnabled && (this.useOrbit || this.#isOrbitModifierActive())) {
                return 'orbit';
            }
        }

        return 'rotate';
    }

    #isOrbitModifierActive() {
        return this.#altKey || this.#keys.has('AltLeft') || this.#keys.has('AltRight');
    }

    #getOrbitDistance() {
        return lengthVector(subtractVectors(this.#camera.position, this.#orbitCenter));
    }
}

function rotateCamera(camera: CameraControlCamera, yawDelta: number, pitchDelta: number) {
    const basis = getCameraBasis(camera);
    const orientation = getCameraOrientationBasis(camera);
    const rollAngle = getForwardAxisRoll(orientation.forward, orientation.up, orientation.viewUp);
    const currentPitch = Math.asin(clamp(dotVector(basis.forward, basis.up), -1, 1));
    const nextPitch = clamp(currentPitch + pitchDelta, -MAX_PITCH, MAX_PITCH);
    const horizontalForward =
        normalizeVector(projectOnPlane(basis.forward, basis.up)) ?? getPerpendicularUnit(basis.up);
    const yawedForward = rotateVectorAroundAxis(horizontalForward, basis.up, yawDelta);
    const forward = normalizeVector(
        addVectors(multiplyVector(yawedForward, Math.cos(nextPitch)), multiplyVector(basis.up, Math.sin(nextPitch))),
    );

    if (!forward) {
        return;
    }

    setCameraLookBasis(camera, forward, getViewUpWithRoll(forward, basis.up, rollAngle));
}

function orbitCamera(
    camera: CameraControlCamera,
    center: CameraControlVector3,
    yawDelta: number,
    pitchDelta: number,
    minDistance: number,
) {
    const basis = getCameraBasis(camera);
    const orientation = getCameraOrientationBasis(camera);
    const rollAngle = getForwardAxisRoll(orientation.forward, orientation.up, orientation.viewUp);
    const safeMinDistance = Math.max(EPSILON, minDistance);
    let distanceValue = lengthVector(subtractVectors(camera.position, center));
    let forward = normalizeVector(subtractVectors(center, camera.position)) ??
        normalizeVector(orientation.forward) ?? { x: 0, y: 0, z: -1 };

    if (distanceValue < safeMinDistance) {
        distanceValue = safeMinDistance;
        forward = normalizeVector(orientation.forward) ?? forward;
    }

    const currentPitch = Math.asin(clamp(dotVector(forward, basis.up), -1, 1));
    const nextPitch = clamp(currentPitch + pitchDelta, -MAX_PITCH, MAX_PITCH);
    const horizontalForward = normalizeVector(projectOnPlane(forward, basis.up)) ?? getPerpendicularUnit(basis.up);
    const yawedForward = rotateVectorAroundAxis(horizontalForward, basis.up, yawDelta);
    const nextForward = normalizeVector(
        addVectors(multiplyVector(yawedForward, Math.cos(nextPitch)), multiplyVector(basis.up, Math.sin(nextPitch))),
    );

    if (!nextForward) {
        return false;
    }

    camera.position.x = center.x - nextForward.x * distanceValue;
    camera.position.y = center.y - nextForward.y * distanceValue;
    camera.position.z = center.z - nextForward.z * distanceValue;
    setCameraLookBasis(camera, nextForward, getViewUpWithRoll(nextForward, basis.up, rollAngle));
    return true;
}

function rollCamera(camera: CameraControlCamera, rollDelta: number) {
    const basis = getCameraOrientationBasis(camera);
    const viewUp = normalizeVector(rotateVectorAroundAxis(basis.viewUp, basis.forward, -rollDelta));

    if (!viewUp) {
        return;
    }

    setCameraLookBasis(camera, basis.forward, viewUp);
}

function getCameraBasis(camera: CameraControlCamera) {
    const orientation = getCameraOrientationBasis(camera);
    const right = normalizeVector(crossVectors(orientation.forward, orientation.up)) ?? orientation.right;
    const viewUp = normalizeVector(crossVectors(right, orientation.forward)) ?? orientation.viewUp;

    return {
        forward: orientation.forward,
        right,
        up: orientation.up,
        viewUp,
    };
}

function getCameraOrientationBasis(camera: CameraControlCamera) {
    const up = getCameraUp(camera);
    const matrix = getCameraRotationMatrix(camera);
    const elements = matrix._elements;
    const forward = normalizeVector({
        x: -elements[8],
        y: -elements[9],
        z: -elements[10],
    }) ?? { x: 0, y: 0, z: -1 };
    const matrixRight =
        normalizeVector({
            x: elements[0],
            y: elements[1],
            z: elements[2],
        }) ?? getPerpendicularUnit(up);
    const viewUp =
        normalizeVector({
            x: elements[4],
            y: elements[5],
            z: elements[6],
        }) ??
        normalizeVector(crossVectors(matrixRight, forward)) ??
        up;

    return {
        forward,
        right: matrixRight,
        up,
        viewUp,
    };
}

function getForwardAxisRoll(forward: CameraControlVector3, up: CameraControlVector3, viewUp: CameraControlVector3) {
    const levelViewUp = getViewUpWithRoll(forward, up, 0);
    return angleAroundAxis(levelViewUp, viewUp, forward);
}

function getViewUpWithRoll(forward: CameraControlVector3, up: CameraControlVector3, rollAngle: number) {
    const right = normalizeVector(crossVectors(forward, up)) ?? getPerpendicularUnit(forward);
    const viewUp = normalizeVector(crossVectors(right, forward)) ?? up;
    return normalizeVector(rotateVectorAroundAxis(viewUp, forward, rollAngle)) ?? viewUp;
}

function setCameraLookBasis(camera: CameraControlCamera, forward: CameraControlVector3, up: CameraControlVector3) {
    const right = normalizeVector(crossVectors(forward, up)) ?? getPerpendicularUnit(up);
    const viewUp = normalizeVector(crossVectors(right, forward)) ?? up;
    const back = multiplyVector(forward, -1);
    const matrix = makeBasisMatrix(right, viewUp, back);
    const rotation = camera.rotation;
    const matrixRotation = rotation as CameraControlEuler & {
        setFromRotationMatrix?: (matrix: CameraControlMatrix4, order?: string) => unknown;
    };

    if (typeof matrixRotation.setFromRotationMatrix === 'function') {
        matrixRotation.setFromRotationMatrix(matrix, rotation.order);
        return;
    }

    const euler = getEulerFromRotationMatrix(matrix, rotation.order ?? 'XYZ');

    if (typeof rotation.set === 'function') {
        rotation.set(euler.x, euler.y, euler.z, euler.order);
    } else {
        rotation.x = euler.x;
        rotation.y = euler.y;
        rotation.z = euler.z;
    }
}

function getCameraUp(camera: CameraControlCamera) {
    return normalizeVector(camera.up ?? DEFAULT_UP) ?? DEFAULT_UP;
}

function getCameraRotationMatrix(camera: CameraControlCamera) {
    if (camera.quaternion) {
        return makeRotationMatrixFromQuaternion(camera.quaternion);
    }

    return makeRotationMatrixFromEuler(camera.rotation);
}

function makeRotationMatrixFromQuaternion(quaternion: CameraControlQuaternion): CameraControlMatrix4 {
    const { x, y, z, w } = quaternion;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    return makeMatrix([
        1 - (yy + zz),
        xy + wz,
        xz - wy,
        0,
        xy - wz,
        1 - (xx + zz),
        yz + wx,
        0,
        xz + wy,
        yz - wx,
        1 - (xx + yy),
        0,
        0,
        0,
        0,
        1,
    ]);
}

function makeRotationMatrixFromEuler(rotation: CameraControlEuler): CameraControlMatrix4 {
    const x = rotation.x;
    const y = rotation.y;
    const z = rotation.z;
    const a = Math.cos(x);
    const b = Math.sin(x);
    const c = Math.cos(y);
    const d = Math.sin(y);
    const e = Math.cos(z);
    const f = Math.sin(z);
    const ae = a * e;
    const af = a * f;
    const be = b * e;
    const bf = b * f;

    return makeMatrix([
        c * e,
        af + be * d,
        bf - ae * d,
        0,
        -c * f,
        ae - bf * d,
        be + af * d,
        0,
        d,
        -b * c,
        a * c,
        0,
        0,
        0,
        0,
        1,
    ]);
}

function makeBasisMatrix(
    xAxis: CameraControlVector3,
    yAxis: CameraControlVector3,
    zAxis: CameraControlVector3,
): CameraControlMatrix4 {
    return makeMatrix([
        xAxis.x,
        xAxis.y,
        xAxis.z,
        0,
        yAxis.x,
        yAxis.y,
        yAxis.z,
        0,
        zAxis.x,
        zAxis.y,
        zAxis.z,
        0,
        0,
        0,
        0,
        1,
    ]);
}

function makeMatrix(elements: number[]): CameraControlMatrix4 {
    return {
        _elements: Float32Array.from(elements),
    };
}

function getEulerFromRotationMatrix(matrix: CameraControlMatrix4, order: string) {
    const te = matrix._elements;
    const m11 = te[0];
    const m12 = te[4];
    const m13 = te[8];
    const m23 = te[9];
    const m33 = te[10];
    const euler = {
        x: 0,
        y: Math.asin(clamp(m13, -1, 1)),
        z: 0,
        order,
    };

    if (Math.abs(m13) < 0.99999) {
        euler.x = Math.atan2(-m23, m33);
        euler.z = Math.atan2(-m12, m11);
    } else {
        const m22 = te[5];
        const m32 = te[6];
        euler.x = Math.atan2(m32, m22);
    }

    return euler;
}

function projectOnPlane(vector: CameraControlVector3, normal: CameraControlVector3) {
    return subtractVectors(vector, multiplyVector(normal, dotVector(vector, normal)));
}

function angleAroundAxis(from: CameraControlVector3, to: CameraControlVector3, axis: CameraControlVector3) {
    const projectedFrom = normalizeVector(projectOnPlane(from, axis));
    const projectedTo = normalizeVector(projectOnPlane(to, axis));

    if (!projectedFrom || !projectedTo) {
        return 0;
    }

    return Math.atan2(dotVector(crossVectors(projectedFrom, projectedTo), axis), dotVector(projectedFrom, projectedTo));
}

function rotateVectorAroundAxis(vector: CameraControlVector3, axis: CameraControlVector3, angle: number) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cross = crossVectors(axis, vector);
    const axisScale = dotVector(axis, vector) * (1 - cos);

    return addVectors(
        addVectors(multiplyVector(vector, cos), multiplyVector(cross, sin)),
        multiplyVector(axis, axisScale),
    );
}

function getPerpendicularUnit(axis: CameraControlVector3) {
    const helper = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    return normalizeVector(crossVectors(axis, helper)) ?? { x: 1, y: 0, z: 0 };
}

function addVectors(a: CameraControlVector3, b: CameraControlVector3) {
    return {
        x: a.x + b.x,
        y: a.y + b.y,
        z: a.z + b.z,
    };
}

function subtractVectors(a: CameraControlVector3, b: CameraControlVector3) {
    return {
        x: a.x - b.x,
        y: a.y - b.y,
        z: a.z - b.z,
    };
}

function multiplyVector(vector: CameraControlVector3, scale: number) {
    return {
        x: vector.x * scale,
        y: vector.y * scale,
        z: vector.z * scale,
    };
}

function copyVector(vector: CameraControlVector3) {
    return {
        x: vector.x,
        y: vector.y,
        z: vector.z,
    };
}

function lengthVector(vector: CameraControlVector3) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function dotVector(a: CameraControlVector3, b: CameraControlVector3) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVectors(a: CameraControlVector3, b: CameraControlVector3) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function normalizeVector(vector: CameraControlVector3) {
    const length = Math.hypot(vector.x, vector.y, vector.z);

    if (length < EPSILON) {
        return undefined;
    }

    return {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
    };
}

function numberFromKey(keys: Set<string>, code: string) {
    return keys.has(code) ? 1 : 0;
}

function distance(x1: number, y1: number, x2: number, y2: number) {
    return Math.hypot(x2 - x1, y2 - y1);
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(Math.max(value, minimum), maximum);
}
