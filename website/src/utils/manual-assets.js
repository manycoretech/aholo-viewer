import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix as pathPosix } from 'node:path';

export const astroAssetsDir = '_astro';
export const assetsPrefix = 'https://holo-cos.aholo3d.cn/aholo-opensource/page';
export const buildHashLength = 16;
export const manualAssetsDir = 'manual';
export const manualAssetPath = `/${astroAssetsDir}/${manualAssetsDir}`;

export function getManualAssetBase(isProd = false) {
    return isProd ? `${assetsPrefix}${manualAssetPath}` : manualAssetPath;
}

export function getManualAssetOutputPath(relativeAssetPath, sourceFilePath, { hash = false } = {}) {
    const normalizedPath = normalizeAssetPath(relativeAssetPath);

    if (!hash) {
        return normalizedPath;
    }

    return addContentHashToAssetPath(normalizedPath, readFileSync(sourceFilePath));
}

export function addContentHashToAssetPath(relativeAssetPath, content) {
    const normalizedPath = normalizeAssetPath(relativeAssetPath);
    const extension = pathPosix.extname(normalizedPath);
    const fileName = pathPosix.basename(normalizedPath, extension);
    const directory = pathPosix.dirname(normalizedPath);
    const hashedFileName = `${fileName}.${createContentHash(content)}${extension}`;

    return directory === '.' ? hashedFileName : `${directory}/${hashedFileName}`;
}

function createContentHash(content) {
    return createHash('sha256').update(content).digest('base64url').slice(0, buildHashLength);
}

function normalizeAssetPath(assetPath) {
    return assetPath.replace(/\\/g, '/');
}
