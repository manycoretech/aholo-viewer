import { clampStreamResolution } from './utils';
import type { UsdCameraParams, UsdMatrix4d } from './types';

/**
 * Column-major 4x4 (e.g. Aholo Viewer `Math.Matrix4.elements`) USDA `matrix4d` rows.
 * USDA uses row-vector layout; column-major world matrices must be transposed for rows.
 */
export function matrixColumnsToUsdMatrix4d(columns: ArrayLike<number>): UsdMatrix4d {
    const rows: UsdMatrix4d = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ];

    for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
            rows[row]![col] = columns[col + row * 4]!;
        }
    }

    return rows;
}

/** USDA `matrix4d` rows column-major 16-element layout (Aholo Viewer `Math.Matrix4.fromArray` indexing). */
export function usdMatrix4dToMatrixColumns(rows: UsdMatrix4d, target = new Float32Array(16)): Float32Array {
    for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
            target[col + row * 4] = rows[row]![col]!;
        }
    }

    return target;
}

/** Build {@link UsdCameraParams} from a column-major world/local matrix and lens fields. */
function usdCameraParamsFromMatrixColumns(
    matrixColumns: ArrayLike<number>,
    params: Omit<UsdCameraParams, 'transform'> & { transform?: UsdMatrix4d },
): UsdCameraParams {
    return {
        ...params,
        transform: params.transform ?? matrixColumnsToUsdMatrix4d(matrixColumns),
    };
}

export function encodeUsdToBase64(usda: string): string {
    const bytes = new TextEncoder().encode(usda);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    if (typeof globalThis.btoa !== 'function') {
        throw new Error('Base64 encoding is not available in this environment.');
    }

    return globalThis.btoa(binary);
}

const DEFAULT_CAMERA_NAME = 'MainCamera';
const DEFAULT_RENDER_SETTINGS_NAME = 'MainRenderSettings';

function formatTuple3(values: [number, number, number]): string {
    return `(${values.map(value => formatUsdNumber(value)).join(', ')})`;
}

function formatMatrix4d(rows: UsdCameraParams['transform']): string {
    if (!rows) {
        throw new Error('UsdCameraParams.transform is required to format matrix4d.');
    }

    const formatted = rows.map(row => `(${row.map(value => formatUsdNumber(value)).join(',')})`).join(', ');
    return `( ${formatted} )`;
}

function formatUsdNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '0';
    }
    const rounded = Math.abs(value) < 1e-6 ? 0 : value;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/\.?0+$/, '');
}

function replaceAttribute(source: string, attribute: string, value: string): string {
    const pattern = new RegExp(`(\\b${escapeRegExp(attribute)}\\s*=\\s*)([^\\n]+)`, 'm');
    if (pattern.test(source)) {
        return source.replace(pattern, `$1${value}`);
    }
    return source;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patchCameraBlock(block: string, camera: UsdCameraParams): string {
    let next = block;

    if (camera.transform) {
        next = replaceAttribute(next, 'matrix4d xformOp:transform', formatMatrix4d(camera.transform));
    } else if (camera.translate && camera.rotateXYZ) {
        next = replaceAttribute(next, 'double3 xformOp:translate', formatTuple3(camera.translate));
        next = replaceAttribute(next, 'float3 xformOp:rotateXYZ', formatTuple3(camera.rotateXYZ));
        if (!/xformOpOrder/.test(next)) {
            next = next.replace(
                /\{\s*/,
                '{\n    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]\n',
            );
        }
    }

    next = replaceAttribute(next, 'float focalLength', formatUsdNumber(camera.focalLength));
    next = replaceAttribute(next, 'float horizontalAperture', formatUsdNumber(camera.horizontalAperture));
    next = replaceAttribute(next, 'float verticalAperture', formatUsdNumber(camera.verticalAperture));

    return next;
}

function patchRenderSettingsBlock(block: string, resolution: { width: number; height: number }): string {
    const value = `(${resolution.width}, ${resolution.height})`;
    if (/int2\s+resolution\s*=/.test(block)) {
        return block.replace(/int2\s+resolution\s*=\s*[^\n]+/m, `int2 resolution = ${value}`);
    }
    return block.replace(/\{\s*/, `{\n    int2 resolution = ${value}\n`);
}

/**
 * Patch `MainCamera` and `MainRenderSettings` inside OpenUSD ASCII (`.usda`).
 * Use before {@link encodeUsdToBase64} when updating the view for `POST ...:push`.
 */
export function patchUsdCamera(
    usda: string,
    camera: UsdCameraParams,
    options?: {
        cameraPrimName?: string;
        renderSettingsPrimName?: string;
    },
): string {
    const patchedCamera: UsdCameraParams = {
        ...camera,
        resolution: clampStreamResolution(camera.resolution),
    };
    const cameraName = options?.cameraPrimName ?? DEFAULT_CAMERA_NAME;
    const renderSettingsName = options?.renderSettingsPrimName ?? DEFAULT_RENDER_SETTINGS_NAME;

    const cameraPattern = new RegExp(
        `(def\\s+Camera\\s+"${escapeRegExp(cameraName)}"\\s*\\{)([\\s\\S]*?)(\\n\\})`,
        'm',
    );
    const renderPattern = new RegExp(
        `(def\\s+RenderSettings\\s+"${escapeRegExp(renderSettingsName)}"\\s*\\{)([\\s\\S]*?)(\\n\\})`,
        'm',
    );

    let next = usda;
    if (cameraPattern.test(next)) {
        next = next.replace(
            cameraPattern,
            (_match, head, body, tail) => `${head}${patchCameraBlock(String(body), patchedCamera)}${tail}`,
        );
    }

    if (renderPattern.test(next)) {
        next = next.replace(
            renderPattern,
            (_match, head, body, tail) =>
                `${head}${patchRenderSettingsBlock(String(body), patchedCamera.resolution)}${tail}`,
        );
    }

    return next;
}
