import { getCameraOrientationBasis } from './camera-control.js';
import type { CameraControl, CameraControlCamera, CameraControlVector3 } from './camera-control.js';

export interface CameraRotationAxisLabels {
    x: string;
    y: string;
    z: string;
}

interface CameraRotationGizmoOptions {
    camera: CameraControlCamera;
    control: CameraControl;
    labels?: Partial<CameraRotationAxisLabels>;
    enabled?: boolean;
    onChange?: () => void;
}

type OrbitGizmoAxisKey = 'x' | 'y' | 'z';

interface OrbitGizmoAxisConfig {
    key: OrbitGizmoAxisKey;
    axis: CameraControlVector3;
    arcStart: CameraControlVector3;
    color: string;
}

interface OrbitGizmoDrag {
    pointerId: number;
    axis: OrbitGizmoAxisConfig;
    element: SVGPathElement;
    lastX: number;
    lastY: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const VIEW_BOX_SIZE = 200;
const GIZMO_RADIUS = 90;
const ARC_SEGMENTS = 48;
const FEATURE_SEGMENTS = 96;
const HALF_PI = Math.PI / 2;
const KEY_STEP_SMALL = (2 * Math.PI) / 180;
const KEY_STEP_LARGE = (10 * Math.PI) / 180;
const MAX_DRAG_STEP = Math.PI / 12;
const EPSILON = 1e-6;

// A fixed oblique view keeps all three camera-local axes visible. The gizmo
// describes the camera frame, so it does not rotate as the camera turns.
const GIZMO_RIGHT = { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 };
const GIZMO_UP = { x: -1 / Math.sqrt(6), y: 2 / Math.sqrt(6), z: -1 / Math.sqrt(6) };

const DEFAULT_LABELS: CameraRotationAxisLabels = {
    x: 'Rotate around camera X / 绕相机 X 轴旋转',
    y: 'Rotate around camera Y / 绕相机 Y 轴旋转',
    z: 'Rotate around camera Z / 绕相机 Z 轴旋转',
};

const AXIS_CONFIGS: OrbitGizmoAxisConfig[] = [
    { key: 'x', axis: { x: 1, y: 0, z: 0 }, arcStart: { x: 0, y: 1, z: 0 }, color: '#e5484d' },
    { key: 'y', axis: { x: 0, y: 1, z: 0 }, arcStart: { x: 0, y: 0, z: 1 }, color: '#46a758' },
    { key: 'z', axis: { x: 0, y: 0, z: 1 }, arcStart: { x: 1, y: 0, z: 0 }, color: '#3e63dd' },
];

const SPHERE_FEATURES = [
    // Equator (XY) and two meridians (XZ / YZ), 90 degrees apart.
    [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
    ],
    [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
    ],
    [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
    ],
] satisfies [CameraControlVector3, CameraControlVector3][];

/**
 * Camera-local rotation sphere overlay. The first-octant quarter arcs use a
 * fixed oblique projection and rotate the camera around its own X/Y/Z axes.
 */
export class CameraRotationGizmo {
    readonly #camera: CameraControlCamera;
    readonly #control: CameraControl;
    readonly #onChange?: () => void;
    readonly #svg: SVGSVGElement;
    readonly #features: SVGPathElement[] = [];
    readonly #arcs = new Map<OrbitGizmoAxisKey, SVGPathElement>();
    readonly #hits = new Map<OrbitGizmoAxisKey, SVGPathElement>();
    #enabled: boolean;
    #drag: OrbitGizmoDrag | null = null;
    #disposed = false;

    constructor(container: HTMLElement, options: CameraRotationGizmoOptions) {
        this.#camera = options.camera;
        this.#control = options.control;
        this.#onChange = options.onChange;
        this.#enabled = options.enabled ?? false;

        const labels = { ...DEFAULT_LABELS, ...options.labels };
        const half = VIEW_BOX_SIZE / 2;
        const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
        svg.setAttribute('viewBox', `${-half} ${-half} ${VIEW_BOX_SIZE} ${VIEW_BOX_SIZE}`);
        svg.setAttribute('role', 'group');
        svg.classList.add('orbit-gizmo');

        for (const _feature of SPHERE_FEATURES) {
            const feature = document.createElementNS(SVG_NAMESPACE, 'path');
            feature.setAttribute('fill', 'none');
            feature.setAttribute('stroke', 'currentColor');
            feature.setAttribute('stroke-width', '1');
            feature.setAttribute('stroke-dasharray', '4 5');
            feature.setAttribute('vector-effect', 'non-scaling-stroke');
            feature.classList.add('orbit-gizmo-feature');
            svg.append(feature);
            this.#features.push(feature);
        }

        const outline = document.createElementNS(SVG_NAMESPACE, 'circle');
        outline.setAttribute('cx', '0');
        outline.setAttribute('cy', '0');
        outline.setAttribute('r', String(GIZMO_RADIUS));
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', 'currentColor');
        outline.setAttribute('stroke-opacity', '0.35');
        outline.setAttribute('stroke-width', '1.5');
        outline.classList.add('orbit-gizmo-outline');
        svg.append(outline);

        for (const config of AXIS_CONFIGS) {
            const arc = document.createElementNS(SVG_NAMESPACE, 'path');
            arc.setAttribute('fill', 'none');
            arc.setAttribute('stroke', config.color);
            arc.setAttribute('stroke-width', '3');
            arc.setAttribute('stroke-linecap', 'round');
            arc.classList.add('orbit-gizmo-arc', `orbit-gizmo-arc-${config.key}`);
            svg.append(arc);
            this.#arcs.set(config.key, arc);

            const hit = document.createElementNS(SVG_NAMESPACE, 'path');
            hit.setAttribute('fill', 'none');
            hit.setAttribute('stroke', '#000');
            hit.setAttribute('stroke-opacity', '0');
            hit.setAttribute('stroke-width', '16');
            hit.setAttribute('tabindex', '0');
            hit.setAttribute('aria-label', labels[config.key]);
            hit.classList.add('orbit-gizmo-hit', `orbit-gizmo-hit-${config.key}`);
            hit.addEventListener('pointerdown', event => this.#onPointerDown(event, config, hit));
            hit.addEventListener('pointermove', this.#onPointerMove);
            hit.addEventListener('pointerup', this.#onPointerUp);
            hit.addEventListener('pointercancel', this.#onPointerUp);
            hit.addEventListener('lostpointercapture', this.#onPointerUp);
            hit.addEventListener('keydown', event => this.#onKeyDown(event, config));
            svg.append(hit);
            this.#hits.set(config.key, hit);
        }

        this.#svg = svg;
        container.append(svg);
        window.addEventListener('blur', this.#onWindowBlur);
        this.setEnabled(this.#enabled);
        this.#renderPaths();
    }

    setEnabled(enabled: boolean) {
        this.#enabled = enabled;
        this.#svg.style.display = enabled ? '' : 'none';

        if (!enabled) {
            this.#endDrag();
        }
    }

    #renderPaths() {
        for (let i = 0; i < SPHERE_FEATURES.length; i++) {
            const [u, v] = SPHERE_FEATURES[i];
            this.#features[i].setAttribute('d', this.#buildGreatCirclePath(u, v));
        }

        for (const config of AXIS_CONFIGS) {
            const path = this.#buildArcPath(config);
            this.#arcs.get(config.key)?.setAttribute('d', path);
            this.#hits.get(config.key)?.setAttribute('d', path);
        }
    }

    dispose() {
        if (this.#disposed) {
            return;
        }

        this.#disposed = true;
        this.#endDrag();
        window.removeEventListener('blur', this.#onWindowBlur);
        this.#svg.remove();
    }

    #onPointerDown(event: PointerEvent, config: OrbitGizmoAxisConfig, element: SVGPathElement) {
        if (!this.#enabled || this.#disposed || event.button !== 0) {
            return;
        }

        this.#endDrag();
        element.focus({ preventScroll: true });
        element.setPointerCapture(event.pointerId);
        element.classList.add('orbit-gizmo-hit-dragging');
        this.#drag = {
            pointerId: event.pointerId,
            axis: config,
            element,
            lastX: event.clientX,
            lastY: event.clientY,
        };
        event.preventDefault();
        event.stopPropagation();
    }

    #onPointerMove = (event: PointerEvent) => {
        const drag = this.#drag;

        if (!drag || event.pointerId !== drag.pointerId || !this.#enabled) {
            return;
        }

        const deltaX = event.clientX - drag.lastX;
        const deltaY = event.clientY - drag.lastY;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;

        const angle = this.#deltaToAngle(drag, event.clientX, event.clientY, deltaX, deltaY);

        if (angle !== 0 && this.#rotateLocalAxis(drag.axis.key, angle)) {
            this.#onChange?.();
        }

        event.preventDefault();
    };

    #onPointerUp = (event: PointerEvent) => {
        if (this.#drag && event.pointerId === this.#drag.pointerId) {
            this.#endDrag();
        }
    };

    #onKeyDown(event: KeyboardEvent, config: OrbitGizmoAxisConfig) {
        if (!this.#enabled || this.#disposed) {
            return;
        }

        let direction = 0;

        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            direction = 1;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            direction = -1;
        }

        if (direction === 0) {
            return;
        }

        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP_SMALL;

        if (this.#rotateLocalAxis(config.key, direction * step)) {
            this.#onChange?.();
        }

        event.preventDefault();
    }

    #onWindowBlur = () => {
        this.#endDrag();
    };

    #endDrag() {
        const drag = this.#drag;

        if (!drag) {
            return;
        }

        this.#drag = null;
        if (drag.element.hasPointerCapture(drag.pointerId)) {
            drag.element.releasePointerCapture(drag.pointerId);
        }

        drag.element.classList.remove('orbit-gizmo-hit-dragging');
    }

    #rotateLocalAxis(key: OrbitGizmoAxisKey, angle: number) {
        const basis = getCameraOrientationBasis(this.#camera);
        const axis =
            key === 'x'
                ? basis.right
                : key === 'y'
                  ? basis.viewUp
                  : { x: -basis.forward.x, y: -basis.forward.y, z: -basis.forward.z };
        return this.#control.rotateAroundWorldAxis(axis, angle);
    }

    #deltaToAngle(drag: OrbitGizmoDrag, clientX: number, clientY: number, deltaX: number, deltaY: number) {
        const rect = this.#svg.getBoundingClientRect();

        if (rect.width < EPSILON || rect.height < EPSILON) {
            return 0;
        }

        const scale = VIEW_BOX_SIZE / rect.width;
        const pointerX = (clientX - (rect.left + rect.width / 2)) * scale;
        const pointerY = (clientY - (rect.top + rect.height / 2)) * scale;
        const t = this.#nearestArcParameter(drag.axis, pointerX, pointerY);
        const point = rotateAroundAxis(drag.axis.arcStart, drag.axis.axis, t);
        const tangent = crossVectors(drag.axis.axis, point);
        const tangentX = dotVector(tangent, GIZMO_RIGHT);
        const tangentY = -dotVector(tangent, GIZMO_UP);
        const tangentLength = Math.hypot(tangentX, tangentY);

        if (tangentLength < EPSILON) {
            return 0;
        }

        const angle = ((deltaX * tangentX + deltaY * tangentY) / tangentLength) * this.#control.lookSpeed;
        return Math.max(-MAX_DRAG_STEP, Math.min(MAX_DRAG_STEP, angle));
    }

    #nearestArcParameter(config: OrbitGizmoAxisConfig, pointerX: number, pointerY: number) {
        let bestT = 0;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let i = 0; i <= ARC_SEGMENTS; i++) {
            const t = (i / ARC_SEGMENTS) * HALF_PI;
            const point = rotateAroundAxis(config.arcStart, config.axis, t);
            const screenX = dotVector(point, GIZMO_RIGHT) * GIZMO_RADIUS;
            const screenY = -dotVector(point, GIZMO_UP) * GIZMO_RADIUS;
            const distanceSquared = (screenX - pointerX) ** 2 + (screenY - pointerY) ** 2;

            if (distanceSquared < bestDistance) {
                bestDistance = distanceSquared;
                bestT = t;
            }
        }

        return bestT;
    }

    #buildArcPath(config: OrbitGizmoAxisConfig) {
        const commands: string[] = [];

        for (let i = 0; i <= ARC_SEGMENTS; i++) {
            const t = (i / ARC_SEGMENTS) * HALF_PI;
            const point = rotateAroundAxis(config.arcStart, config.axis, t);
            const screenX = dotVector(point, GIZMO_RIGHT) * GIZMO_RADIUS;
            const screenY = -dotVector(point, GIZMO_UP) * GIZMO_RADIUS;
            commands.push(`${i === 0 ? 'M' : 'L'}${screenX.toFixed(2)},${screenY.toFixed(2)}`);
        }

        return commands.join(' ');
    }

    #buildGreatCirclePath(u: CameraControlVector3, v: CameraControlVector3) {
        const commands: string[] = [];

        for (let i = 0; i <= FEATURE_SEGMENTS; i++) {
            const angle = (i / FEATURE_SEGMENTS) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const point = {
                x: u.x * cos + v.x * sin,
                y: u.y * cos + v.y * sin,
                z: u.z * cos + v.z * sin,
            };
            const screenX = dotVector(point, GIZMO_RIGHT) * GIZMO_RADIUS;
            const screenY = -dotVector(point, GIZMO_UP) * GIZMO_RADIUS;
            commands.push(`${i === 0 ? 'M' : 'L'}${screenX.toFixed(2)},${screenY.toFixed(2)}`);
        }

        commands.push('Z');
        return commands.join(' ');
    }
}

function rotateAroundAxis(vector: CameraControlVector3, axis: CameraControlVector3, angle: number) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cross = crossVectors(axis, vector);
    const axisScale = dotVector(axis, vector) * (1 - cos);

    return {
        x: vector.x * cos + cross.x * sin + axis.x * axisScale,
        y: vector.y * cos + cross.y * sin + axis.y * axisScale,
        z: vector.z * cos + cross.z * sin + axis.z * axisScale,
    };
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
