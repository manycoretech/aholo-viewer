import path from 'node:path';
import { unzipSync } from 'fflate';

type ArchiveFormat = 'SOG' | 'LCC' | 'LCC2';

export function isZipArchive(buffer: Uint8Array) {
    if (buffer.byteLength < 4) {
        return false;
    }
    const magic = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, true);
    return magic === 0x04034b50 || magic === 0x06054b50;
}

export function normalizeArchivePath(value: string) {
    return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\/+/, '');
}

export function resolveArchivePath(metadataPath: string, reference: string) {
    const name = reference.replace(/\\/g, '/');
    return normalizeArchivePath(
        name.startsWith('/') ? name : path.posix.join(path.posix.dirname(normalizeArchivePath(metadataPath)), name),
    );
}

export function isArchiveMetadata(filename: string, format: ArchiveFormat) {
    const name = path.posix.basename(normalizeArchivePath(filename)).toLowerCase();
    return (
        !name.startsWith('._') && (format === 'SOG' ? name === 'meta.json' : name.endsWith(`.${format.toLowerCase()}`))
    );
}

export function readZipMetadata(buffer: Uint8Array, format: ArchiveFormat) {
    const paths = new Map<string, string>();
    const metadata = unzipSync(buffer, {
        filter: entry => {
            const normalized = normalizeArchivePath(entry.name);
            if (normalized.endsWith('/')) {
                return false;
            }
            if (paths.has(normalized)) {
                throw new Error(`Duplicate ${format} archive path: ${normalized}`);
            }
            paths.set(normalized, entry.name);
            return isArchiveMetadata(normalized, format);
        },
    });
    const metaPaths = Object.keys(metadata);
    if (metaPaths.length !== 1) {
        throw new Error(`Expected one ${format} metadata file in the zip archive, found ${metaPaths.length}.`);
    }
    const metaPath = metaPaths[0];
    return { paths, metaPath, metadata: metadata[metaPath] };
}

export function readZipEntries(buffer: Uint8Array, paths: Iterable<string>) {
    const selected = new Set(paths);
    return unzipSync(buffer, { filter: entry => selected.has(entry.name) });
}
