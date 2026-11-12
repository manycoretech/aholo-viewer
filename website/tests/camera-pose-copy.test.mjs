import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/client/camera-pose-copy.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { mountCameraPoseCopy, serializeCameraPose, CAMERA_POSE_TOAST_DURATION_MS } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
    for (const [key, descriptor] of [
        ['window', originalWindow],
        ['navigator', originalNavigator],
    ]) {
        if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
        } else {
            delete globalThis[key];
        }
    }
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function element() {
    const listeners = new Map();
    const styles = new Map();
    return {
        dataset: { visible: 'false' },
        style: { setProperty: (key, value) => styles.set(key, value) },
        styles,
        textContent: '',
        offsetWidth: 80,
        addEventListener: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
        click: () => Promise.all(Array.from(listeners.get('click') ?? [], listener => listener())),
        listenerCount: () => Array.from(listeners.values()).reduce((sum, values) => sum + values.size, 0),
    };
}

function fixture(writeText) {
    const button = element();
    const toast = element();
    const message = element();
    const close = element();
    const timers = new Map();
    const writes = [];
    const errors = [];
    const camera = {
        position: { x: 2.123456789, y: -3.5, z: 7 },
        quaternion: { x: 0.1, y: -0.2, z: 0.3, w: 0.9273618495 },
    };
    let loaded = true;
    let preset = 'opencv';
    let timerId = 0;
    let clipboard;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            setTimeout: (callback, duration) => {
                timers.set(++timerId, { callback, duration });
                return timerId;
            },
            clearTimeout: id => timers.delete(id),
        },
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            clipboard: {
                writeText: text => {
                    writes.push(JSON.parse(text));
                    return (writeText?.(text) ?? Promise.resolve()).then(() => {
                        // Model the browser updating the clipboard on completion.
                        clipboard = JSON.parse(text);
                    });
                },
            },
        },
    });
    const elements = new Map([
        ['[data-camera-pose-copy]', button],
        ['[data-pose-toast]', toast],
        ['[data-pose-toast-message]', message],
        ['[data-pose-toast-close]', close],
    ]);
    const feature = mountCameraPoseCopy({
        root: { querySelector: selector => elements.get(selector) },
        getCamera: () => camera,
        getWorldUpPreset: () => preset,
        hasLoadedFiles: () => loaded,
        labels: { copiedPose: 'copied', poseNoFile: 'no file' },
        onError: error => errors.push(error),
    });
    return {
        feature,
        button,
        toast,
        message,
        close,
        timers,
        writes,
        errors,
        camera,
        getClipboard: () => clipboard,
        setLoaded: value => (loaded = value),
        setPreset: value => (preset = value),
        expire: () => {
            for (const [id, timer] of Array.from(timers)) {
                timers.delete(id);
                timer.callback();
            }
        },
    };
}

test('all presets describe the same camera basis and preserve exact pose values without mutation', () => {
    const camera = Object.freeze({
        position: Object.freeze({ x: 1.234567891234, y: -3, z: 1e-15 }),
        quaternion: Object.freeze({ x: 0.1, y: -0.2, z: 0.3, w: 0.9273618495 }),
    });
    for (const preset of ['opencv', 'opengl', 'aholo']) {
        const pose = serializeCameraPose(camera, preset);
        assert.deepEqual(pose, {
            type: 'camera-pose',
            convention: 'camera-to-world',
            coordinateSystem: preset,
            worldUpPreset: preset,
            cameraAxes: { right: '+X', up: '+Y', forward: '-Z' },
            position: camera.position,
            quaternion: camera.quaternion,
        });
        assert.notEqual(pose.position, camera.position);
        assert.notEqual(pose.quaternion, camera.quaternion);
    }
});

test('success copies a snapshot, uses one synchronized timer, and fades out', async () => {
    const f = fixture();
    const before = structuredClone(f.camera);
    f.setPreset('aholo');
    await f.button.click();
    assert.deepEqual(f.camera, before);
    assert.deepEqual(f.writes[0], serializeCameraPose(before, 'aholo'));
    assert.equal(f.toast.dataset.state, 'success');
    assert.equal(f.toast.dataset.visible, 'true');
    assert.equal(f.message.textContent, 'copied');
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].duration, CAMERA_POSE_TOAST_DURATION_MS);
    assert.equal(f.toast.styles.get('--viewer-pose-toast-duration'), `${CAMERA_POSE_TOAST_DURATION_MS}ms`);
    f.camera.position.x = 100;
    assert.equal(f.writes[0].position.x, before.position.x);
    f.expire();
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
});

test('empty scenes show the red notice without accessing the clipboard', async () => {
    const f = fixture();
    f.setLoaded(false);
    await f.button.click();
    assert.equal(f.writes.length, 0);
    assert.equal(f.toast.dataset.state, 'error');
    assert.equal(f.message.textContent, 'no file');
    assert.equal(f.toast.dataset.visible, 'true');
    assert.equal(f.timers.size, 1);
});

test('clipboard denial reports through the existing viewer error callback', async () => {
    const denied = new Error('permission denied');
    const f = fixture(() => Promise.reject(denied));
    await f.button.click();
    assert.deepEqual(f.errors, [denied]);
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
});

test('repeated copies refresh the same notification and replace its only timer', async () => {
    const f = fixture();
    await f.button.click();
    const firstTimer = [...f.timers.keys()][0];
    await f.button.click();
    assert.equal(f.writes.length, 2);
    assert.equal(f.timers.size, 1);
    assert.notEqual([...f.timers.keys()][0], firstTimer);
    await f.close.click();
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
});

test('close suppresses a late notification without cancelling the copy', async () => {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const click = f.button.click();
    await f.close.click();
    pending.resolve();
    await click;
    assert.deepEqual(f.getClipboard(), serializeCameraPose(f.camera, 'opencv'));
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
});

test('dispose removes listeners, clears timers and suppresses late success or rejection', async () => {
    for (const reject of [false, true]) {
        const pending = deferred();
        const f = fixture(() => pending.promise);
        const click = f.button.click();
        f.feature.dispose();
        f.feature.dispose();
        if (reject) pending.reject(new Error('late denial'));
        else pending.resolve();
        await click;
        await f.button.click();
        assert.equal(f.button.listenerCount(), 0);
        assert.equal(f.close.listenerCount(), 0);
        assert.equal(f.writes.length, 1);
        assert.equal(f.errors.length, 0);
        assert.equal(f.toast.dataset.visible, 'false');
        assert.equal(f.timers.size, 0);
    }
    const f = fixture();
    await f.button.click();
    f.feature.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(f.toast.dataset.visible, 'false');
});

test('writes start serially and the last click snapshot remains on the clipboard', async () => {
    const first = deferred();
    const second = deferred();
    let count = 0;
    const f = fixture(() => (++count === 1 ? first.promise : second.promise));
    const click1 = f.button.click();
    // The first write starts synchronously within the click's user activation.
    assert.equal(f.writes.length, 1);
    f.camera.position.x = 22;
    const click2 = f.button.click();
    f.camera.position.x = 33;
    assert.equal(f.writes.length, 1);
    // Even if the later operation is already resolved, it cannot write first.
    second.resolve();
    assert.equal(f.getClipboard(), undefined);
    first.resolve();
    await click1;
    await click2;
    assert.equal(f.writes.length, 2);
    assert.equal(f.getClipboard().position.x, 22);
    assert.equal(f.toast.dataset.state, 'success');
    assert.equal(f.timers.size, 1);
    assert.equal(f.errors.length, 0);
});

test('an older clipboard failure does not block the next queued snapshot or report an old error', async () => {
    const first = deferred();
    const second = deferred();
    let count = 0;
    const f = fixture(() => (++count === 1 ? first.promise : second.promise));
    const click1 = f.button.click();
    f.camera.position.x = 44;
    const click2 = f.button.click();
    first.reject(new Error('old failure'));
    await click1;
    assert.equal(f.writes.length, 2);
    second.resolve();
    await click2;
    assert.equal(f.getClipboard().position.x, 44);
    assert.equal(f.toast.dataset.state, 'success');
    assert.equal(f.timers.size, 1);
    assert.equal(f.errors.length, 0);
});

test('closing the notice keeps queued snapshots but suppresses their late notifications', async () => {
    const first = deferred();
    const second = deferred();
    let count = 0;
    const f = fixture(() => (++count === 1 ? first.promise : second.promise));
    const click1 = f.button.click();
    f.camera.position.x = 66;
    const click2 = f.button.click();
    await f.close.click();
    first.resolve();
    await click1;
    second.resolve();
    await click2;
    assert.equal(f.writes.length, 2);
    assert.equal(f.getClipboard().position.x, 66);
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
    assert.equal(f.errors.length, 0);
});

test('dispose cancels queued writes that have not started', async () => {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const click1 = f.button.click();
    f.camera.position.x = 55;
    const click2 = f.button.click();
    assert.equal(f.writes.length, 1);
    f.feature.dispose();
    pending.resolve();
    await Promise.all([click1, click2]);
    assert.equal(f.writes.length, 1);
    assert.notEqual(f.getClipboard().position.x, 55);
    assert.equal(f.toast.dataset.visible, 'false');
    assert.equal(f.timers.size, 0);
    assert.equal(f.errors.length, 0);
});

test('a newer empty-scene notice cannot be replaced by an older successful copy', async () => {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const oldClick = f.button.click();
    f.setLoaded(false);
    await f.button.click();
    const latestTimer = [...f.timers.keys()][0];
    pending.resolve();
    await oldClick;
    assert.equal(f.toast.dataset.state, 'error');
    assert.equal(f.message.textContent, 'no file');
    assert.equal([...f.timers.keys()][0], latestTimer);
    assert.equal(f.timers.size, 1);
});
