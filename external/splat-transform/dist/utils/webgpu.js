/// <reference types="@webgpu/types" />
import { createRequire } from 'node:module';
import { logger } from './index.js';
const getModule = (function () {
    let m = undefined;
    return function () {
        if (!m) {
            m = createRequire(import.meta.url)('webgpu');
            Object.assign(globalThis, m.globals);
        }
        return m;
    };
})();
let gpu = undefined;
// Get Dawn's actual adapter names by triggering its error message.
// This is the official documented method for enumerating adapters:
// https://github.com/dawn-gpu/node-webgpu?tab=readme-ov-file#usage
async function getDawnAdapterNames() {
    try {
        const gpu = getModule().create(['adapter=__list_adapters__']);
        await gpu.requestAdapter();
    }
    catch (e) {
        // Parse Dawn's error message to extract adapter names
        const message = e instanceof Error ? e.message : String(e);
        const lines = message.split('\n');
        const names = [];
        for (const line of lines) {
            // Look for lines like: " * backend: 'd3d12', name: 'NVIDIA RTX A2000 8GB Laptop GPU'"
            const match = line.match(/name:\s*'([^']+)'/);
            if (match) {
                names.push(match[1]);
            }
        }
        return names;
    }
    // Unexpected: requestAdapter should have thrown with invalid adapter name
    logger.warn('Expected adapter enumeration to throw an error, but it did not.');
    return [];
}
;
// Cache enumerated adapters so we don't query Dawn multiple times
let cachedAdapters = null;
export async function enumerateAdapters() {
    if (cachedAdapters) {
        return cachedAdapters;
    }
    try {
        logger.info('Detecting GPU adapters...');
        // Get the actual adapter names directly from Dawn
        const dawnAdapterNames = await getDawnAdapterNames();
        // Cache and return the list
        cachedAdapters = dawnAdapterNames.map((name, index) => ({
            index,
            name
        }));
        return cachedAdapters;
    }
    catch (e) {
        logger.error('Failed to enumerate adapters. Error:');
        logger.error(e);
        logger.error('\nThis usually means WebGPU is not available. Please ensure:');
        logger.error('  - Your GPU drivers are up to date');
        logger.error('  - Your GPU supports Vulkan, D3D12, or Metal');
        return [];
    }
}
;
export function initGPUAdapter(options = []) {
    if (!gpu) {
        logger.info(`Init WebGPU adapter${options.length > 0 ? ` with [${options.join(';')}]` : '.'}`);
        gpu = getModule().create(options);
    }
}
export async function createDevice() {
    initGPUAdapter();
    const adapter = await gpu.requestAdapter({
        powerPreference: 'high-performance'
    });
    if (!adapter) {
        throw new Error(`No available WebGPU adapter found.`);
    }
    const device = await adapter.requestDevice({
        requiredFeatures: Array.from(adapter.features),
        requiredLimits: adapter.limits
    });
    if (!device) {
        throw new Error('Create WebGPU device failed.');
    }
    logger.info(`WebGPU device created: ${device.adapterInfo.vendor}, ${device.adapterInfo.device}, ${device.adapterInfo.description}`);
    device.addEventListener('uncapturederror', (event) => {
        const error = event.error;
        const type = error?.type ? ` (${error.type})` : '';
        logger.error(`WebGPU uncaptured error${type}: ${error?.message ?? String(error)}`);
    });
    device.lost.then((info) => {
        const message = info.message ? `, message=${info.message}` : '';
        if (info.reason === 'destroyed') {
            return;
        }
        logger.warn(`WebGPU device lost unexpectedly: reason=${info.reason}${message}`);
    }).catch((e) => {
        logger.error(`WebGPU device lost handler failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return device;
}
const { getOrCreateDevice, releaseSharedDevice } = (function () {
    let device = undefined;
    return {
        async getOrCreateDevice() {
            if (!device) {
                device = await createDevice();
            }
            return device;
        },
        releaseSharedDevice() {
            device?.destroy();
            device = undefined;
        }
    };
})();
export { getOrCreateDevice, releaseSharedDevice };
