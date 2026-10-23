import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import ts from 'typescript';

// Compile the internal browser modules without adding a runtime/test dependency.
const output = await mkdtemp(join(tmpdir(), 'aholo-camera-rotation-'));
for (const name of ['camera-control', 'camera-rotation-gizmo', 'camera-rotation']) {
    const source = await readFile(new URL(`../src/client/${name}.ts`, import.meta.url), 'utf8');
    const result = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    await writeFile(join(output, `${name}.mjs`), result.outputText.replaceAll(".js'", ".mjs'"));
}
after(() => rm(output, { recursive: true, force: true }));
const { CameraControl, getCameraOrientationBasis } = await import(pathToFileURL(join(output, 'camera-control.mjs')));
const { mountCameraRotation } = await import(pathToFileURL(join(output, 'camera-rotation.mjs')));

class ElementStub extends EventTarget {
    attributes = new Map();
    children = [];
    captures = new Set();
    style = { touchAction: '' };
    classes = new Set();
    classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
    };
    checked = false;
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
    removeAttribute(name) {
        this.attributes.delete(name);
    }
    append(element) {
        this.children.push(element);
        element.parent = this;
    }
    remove() {
        this.parent.children = this.parent.children.filter(child => child !== this);
    }
    focus() {}
    setPointerCapture(id) {
        this.captures.add(id);
    }
    hasPointerCapture(id) {
        return this.captures.has(id);
    }
    releasePointerCapture(id) {
        this.captures.delete(id);
        this.emit('lostpointercapture', { pointerId: id });
    }
    getBoundingClientRect() {
        return { left: 0, top: 0, width: 180, height: 180 };
    }
    emit(type, fields = {}) {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, fields);
        this.dispatchEvent(event);
        return event;
    }
}

globalThis.window = new ElementStub();
globalThis.document = { createElementNS: () => new ElementStub() };

const axis = (key, angle) => {
    const q = { x: 0, y: 0, z: 0, w: Math.cos(angle / 2) };
    q[key] = Math.sin(angle / 2);
    return q;
};
function multiply(a, b) {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}
function rotate(q, v) {
    const result = multiply(multiply(q, { ...v, w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
    return { x: result.x, y: result.y, z: result.z };
}
function close(actual, expected, epsilon = 2e-6) {
    for (const key of Object.keys(expected)) {
        assert.ok(Math.abs(actual[key] - expected[key]) < epsilon, `${key}: ${actual[key]} != ${expected[key]}`);
    }
}
function closeQuaternion(actual, expected) {
    const sign =
        actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w < 0 ? -1 : 1;
    close(actual, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * sign])));
}
function camera(quaternion = axis('z', Math.PI / 2), position = { x: 0, y: 0, z: 5 }) {
    const result = { position: { ...position }, up: { x: 0, y: 1, z: 0 }, quaternion: { ...quaternion } };
    result.rotation = {
        x: 0,
        y: 0,
        z: 0,
        order: 'XYZ',
        // Convert the written orthonormal basis to a quaternion, independent of
        // CameraControl's Euler decomposition and exposed orientation helper.
        setFromRotationMatrix({ _elements: e }) {
            const trace = e[0] + e[5] + e[10];
            let q;
            if (trace > 0) {
                const s = 2 * Math.sqrt(trace + 1);
                q = { w: s / 4, x: (e[6] - e[9]) / s, y: (e[8] - e[2]) / s, z: (e[1] - e[4]) / s };
            } else if (e[0] > e[5] && e[0] > e[10]) {
                const s = 2 * Math.sqrt(1 + e[0] - e[5] - e[10]);
                q = { w: (e[6] - e[9]) / s, x: s / 4, y: (e[4] + e[1]) / s, z: (e[8] + e[2]) / s };
            } else if (e[5] > e[10]) {
                const s = 2 * Math.sqrt(1 + e[5] - e[0] - e[10]);
                q = { w: (e[8] - e[2]) / s, x: (e[4] + e[1]) / s, y: s / 4, z: (e[9] + e[6]) / s };
            } else {
                const s = 2 * Math.sqrt(1 + e[10] - e[0] - e[5]);
                q = { w: (e[1] - e[4]) / s, x: (e[8] + e[2]) / s, y: (e[9] + e[6]) / s, z: s / 4 };
            }
            result.quaternion = q;
        },
    };
    return result;
}
function setup(options = {}, initial = camera()) {
    const surface = new ElementStub();
    const control = new CameraControl(initial, surface, options);
    return { camera: initial, surface, control };
}
function pointer(surface, type, fields = {}) {
    return surface.emit(type, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 0,
        clientY: 0,
        altKey: false,
        ...fields,
    });
}
function drag({ surface, control }, fields = {}) {
    pointer(surface, 'pointerdown', fields);
    pointer(surface, 'pointermove', { clientX: 50, clientY: 30, ...fields });
    control.update(0);
    pointer(surface, 'pointerup', fields);
}
function key(surface, type, code) {
    surface.emit(type, { code, altKey: false, getModifierState: () => false });
}

test('shared default world-up free-look preserves official yaw/pitch and existing roll', () => {
    const state = setup();
    assert.equal(state.control.navigationSpace, 'world-up');
    drag(state);
    const expected = multiply(multiply(axis('y', -0.2), axis('x', -0.12)), axis('z', Math.PI / 2));
    closeQuaternion(state.camera.quaternion, expected);
    close(state.camera.position, { x: 0, y: 0, z: 5 });
    state.control.dispose();
});

test('shared default WASDQE and pan stay world-up even after a 90 degree camera roll', () => {
    const expected = {
        KeyW: { x: 0, y: 0, z: 4.6 },
        KeyS: { x: 0, y: 0, z: 5.4 },
        KeyA: { x: -0.4, y: 0, z: 5 },
        KeyD: { x: 0.4, y: 0, z: 5 },
        KeyQ: { x: 0, y: 0.4, z: 5 },
        KeyE: { x: 0, y: -0.4, z: 5 },
    };
    for (const [code, position] of Object.entries(expected)) {
        const state = setup();
        key(state.surface, 'keydown', code);
        state.control.update(1);
        close(state.camera.position, position);
        state.control.dispose();
    }
    const state = setup();
    drag(state, { button: 2 });
    close(state.camera.position, { x: 0.3, y: -0.18, z: 5 });
    state.control.dispose();
});

test('shared useOrbit and Alt retain official position-orbit semantics and radius', () => {
    for (const useOrbit of [true, false]) {
        const state = setup({ useOrbit });
        drag(state, { altKey: !useOrbit });
        const forward = rotate(multiply(axis('y', -0.2), axis('x', -0.12)), { x: 0, y: 0, z: -1 });
        close(state.camera.position, { x: -forward.x * 5, y: -forward.y * 5, z: -forward.z * 5 });
        assert.ok(Math.abs(Math.hypot(...Object.values(state.camera.position)) - 5) < 1e-6);
        closeQuaternion(
            state.camera.quaternion,
            multiply(multiply(axis('y', -0.2), axis('x', -0.12)), axis('z', Math.PI / 2)),
        );
        state.control.dispose();
    }
});

test('Viewer opt-in free-look composes rotations in the rolled camera frame', () => {
    const initial = multiply(multiply(axis('y', 0.7), axis('x', -0.4)), axis('z', 1.1));
    const state = setup({ navigationSpace: 'camera-local', lookSpeed: 0.0015 }, camera(initial));
    drag(state);
    closeQuaternion(state.camera.quaternion, multiply(initial, multiply(axis('y', -0.075), axis('x', -0.045))));
    close(state.camera.position, { x: 0, y: 0, z: 5 });
    state.control.dispose();
});

test('shared pitch clamp remains world-up while camera-local rotation can pass the pole', () => {
    for (const navigationSpace of ['world-up', 'camera-local']) {
        const state = setup({ navigationSpace, lookSpeed: 0.0015 }, camera(axis('x', 0)));
        pointer(state.surface, 'pointerdown');
        pointer(state.surface, 'pointermove', { clientY: -2000 });
        state.control.update(0);
        closeQuaternion(state.camera.quaternion, axis('x', navigationSpace === 'world-up' ? Math.PI / 2 - 0.001 : 3));
        state.control.dispose();
    }
});

test('Viewer WASDQE, pan, and wheel follow the current pitched and rolled camera frame', () => {
    const initial = multiply(multiply(axis('y', 0.7), axis('x', -0.4)), axis('z', 1.1));
    const directions = {
        KeyW: [0, 0, -1],
        KeyS: [0, 0, 1],
        KeyA: [-1, 0, 0],
        KeyD: [1, 0, 0],
        KeyQ: [0, 1, 0],
        KeyE: [0, -1, 0],
    };
    for (const [code, [x, y, z]] of Object.entries(directions)) {
        const state = setup({ navigationSpace: 'camera-local' }, camera(initial));
        key(state.surface, 'keydown', code);
        state.control.update(1);
        const delta = rotate(initial, { x: x * 0.4, y: y * 0.4, z: z * 0.4 });
        close(state.camera.position, { x: delta.x, y: delta.y, z: 5 + delta.z });
        state.control.dispose();
    }
    const state = setup({ navigationSpace: 'camera-local' }, camera(initial));
    drag(state, { button: 2 });
    const pan = rotate(initial, { x: 0.3, y: -0.18, z: 0 });
    close(state.camera.position, { x: pan.x, y: pan.y, z: 5 + pan.z });
    state.surface.emit('wheel', { deltaY: 100 });
    state.control.update(0);
    const wheel = rotate(initial, { x: 0, y: 0, z: 0.6 });
    close(state.camera.position, { x: pan.x + wheel.x, y: pan.y + wheel.y, z: 5 + pan.z + wheel.z });
    state.control.dispose();
});

test('world-axis rotation preserves position and matches quaternion pre-multiplication', () => {
    const initial = multiply(axis('y', 0.7), axis('z', 1.1));
    for (const key of ['x', 'y', 'z']) {
        const state = setup({}, camera(initial, { x: 3, y: -2, z: 7 }));
        const vector = { x: 0, y: 0, z: 0, [key]: 3 };
        assert.equal(state.control.rotateAroundWorldAxis(vector, 0.3), true);
        closeQuaternion(state.camera.quaternion, multiply(axis(key, 0.3), initial));
        assert.deepEqual(state.camera.position, { x: 3, y: -2, z: 7 });
        state.control.dispose();
    }
});

test('rotation rejects invalid axes/angles and respects disabled/disposed controls', () => {
    const state = setup();
    const before = { ...state.camera.quaternion };
    for (const vector of [
        { x: 0, y: 0, z: 0 },
        { x: NaN, y: 0, z: 0 },
        { x: Infinity, y: 0, z: 0 },
        { x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: Number.MAX_VALUE },
    ]) {
        assert.equal(state.control.rotateAroundWorldAxis(vector, 0.2), false);
    }
    for (const angle of [0, NaN, Infinity]) {
        assert.equal(state.control.rotateAroundWorldAxis({ x: 1, y: 0, z: 0 }, angle), false);
    }
    state.control.enabled = false;
    assert.equal(state.control.rotateAroundWorldAxis({ x: 1, y: 0, z: 0 }, 0.2), false);
    state.control.enabled = true;
    state.control.dispose();
    assert.equal(state.control.rotateAroundWorldAxis({ x: 1, y: 0, z: 0 }, 0.2), false);
    assert.deepEqual(state.camera.quaternion, before);
});

test('rotation feature owns toggle/Alt behavior, local arc keys, cancellation, and disposal', () => {
    const state = setup({ navigationSpace: 'camera-local', lookSpeed: 0.0015 });
    const toggle = new ElementStub();
    const container = new ElementStub();
    const feature = mountCameraRotation({
        root: { querySelector: () => toggle },
        container,
        camera: state.camera,
        control: state.control,
        labels: { x: 'X', y: 'Y', z: 'Z' },
        onChange() {},
    });
    const svg = container.children[0];
    assert.equal(svg.style.display, 'none');
    toggle.checked = true;
    toggle.emit('change');
    assert.equal(state.control.orbitEnabled, false);
    drag(state, { altKey: true });
    assert.deepEqual(state.camera.position, { x: 0, y: 0, z: 5 });
    for (const axisKey of ['x', 'y', 'z']) {
        const arc = svg.children.find(child => child.classes.has(`orbit-gizmo-hit-${axisKey}`));
        for (const shiftKey of [false, true]) {
            const previous = { ...state.camera.quaternion };
            arc.emit('keydown', { key: 'ArrowRight', shiftKey });
            closeQuaternion(
                state.camera.quaternion,
                multiply(previous, axis(axisKey, ((shiftKey ? 10 : 2) * Math.PI) / 180)),
            );
            assert.deepEqual(state.camera.position, { x: 0, y: 0, z: 5 });
        }
    }
    const hit = svg.children.find(child => child.classes.has('orbit-gizmo-hit-x'));
    const position = { ...state.camera.position };
    pointer(hit, 'pointerdown');
    assert.equal(hit.hasPointerCapture(1), true);
    pointer(hit, 'pointercancel');
    assert.equal(hit.hasPointerCapture(1), false);
    assert.deepEqual(state.camera.position, position);
    assert.equal(hit.classes.has('orbit-gizmo-hit-dragging'), false);
    pointer(hit, 'pointerdown');
    window.emit('blur');
    assert.equal(hit.hasPointerCapture(1), false);
    toggle.checked = false;
    toggle.emit('change');
    assert.equal(state.control.orbitEnabled, true);
    drag(state, { altKey: true });
    assert.notDeepEqual(state.camera.position, position);
    feature.dispose();
    feature.dispose();
    assert.equal(container.children.length, 0);
    toggle.checked = true;
    toggle.emit('change');
    assert.equal(state.control.orbitEnabled, true);
    state.control.dispose();
});

test('local basis reflects quaternion axes rather than the selected world up', () => {
    const initial = multiply(axis('x', 0.4), axis('z', 0.8));
    const value = camera(initial);
    value.up = { x: 0, y: 0, z: 1 };
    const basis = getCameraOrientationBasis(value);
    close(basis.right, rotate(initial, { x: 1, y: 0, z: 0 }));
    close(basis.viewUp, rotate(initial, { x: 0, y: 1, z: 0 }));
    close(basis.forward, rotate(initial, { x: 0, y: 0, z: -1 }));
});
