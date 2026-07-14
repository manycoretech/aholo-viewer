import { parentPort } from 'node:worker_threads';
import { writeSplatFile, type ISplatData } from '../utils/splat.js';
import { SplatData } from '../SplatData.js';
import { logger } from '../utils/index.js';

if (!parentPort) {
    throw new Error('worker must run inside worker_threads');
}

logger.silent = true;

parentPort.on('message', async e => {
    try {
        const { filepath, data, enableMortonSort, version, highPrecision, compressLevel } = e as {
            filepath: string;
            data: ISplatData;
            enableMortonSort: boolean;
            version?: number;
            highPrecision?: boolean;
            compressLevel?: number;
        };
        const splatData = new SplatData();
        splatData.deserialize(data);
        await writeSplatFile(filepath, splatData, enableMortonSort, compressLevel, highPrecision, version);
        parentPort!.postMessage({ success: true, content: '' });
    } catch (e) {
        parentPort!.postMessage({ success: false, content: e.toString() });
    }
});
