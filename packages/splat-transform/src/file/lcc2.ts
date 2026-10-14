import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SplatData } from '../SplatData.js';
import { createSplatFile, deferred, SplatFileType } from '../utils/index.js';
import {
    isZipArchive,
    normalizeArchivePath,
    readZipEntries,
    readZipMetadata,
    resolveArchivePath,
} from '../utils/zip.js';
import type { IFile } from './IFile.js';

interface SplatRef {
    name: number;
    start?: number;
    count?: number;
}

interface Lcc2Node {
    data?: {
        '3dgs'?: SplatRef;
        env?: SplatRef;
    };
    child?: Lcc2Node[] | Record<string, Lcc2Node>;
    splatFiles?: string[];
    files?: string[];
}

interface Metadata {
    version?: string;
    totalLevels?: number;
    lod_level?: number;
    splatType?: string;
    root: Lcc2Node;
}

interface SplatRange {
    start: number;
    end: number;
}

function collectRanges(refs: SplatRef[], counts: number, filename: string): SplatRange[] {
    const ranges = refs.map(ref => {
        const start = ref.start ?? 0;
        const count = ref.count ?? counts - start;
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(count) ||
            start < 0 ||
            count < 0 ||
            start + count > counts
        ) {
            throw new Error(
                `Invalid LCC2 splat range in ${filename}: start=${start}, count=${count}, counts=${counts}`,
            );
        }
        return { start, end: start + count };
    });
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: SplatRange[] = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push(range);
        }
    }
    return merged;
}

// https://github.com/xgrids/LCC2Whitepaper
export class Lcc2File implements IFile {
    constructor(private readonly filename?: string) {}

    private load(buffer: Uint8Array) {
        if (isZipArchive(buffer)) {
            return this.loadArchive(buffer);
        }
        if (!this.filename) {
            throw new Error('Unpacked LCC2 input requires the .lcc2 metadata file path.');
        }
        const meta: Metadata = JSON.parse(new TextDecoder().decode(buffer));
        const baseDir = path.dirname(path.resolve(this.filename));
        const { splatType, selected } = this.collectFiles(meta, name => {
            const candidates = [path.resolve(baseDir, name), path.join(baseDir, path.posix.basename(name))];
            const filename = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
            return filename === undefined ? undefined : fs.realpathSync(filename);
        });
        return {
            splatType,
            files: [...selected].map(([filename, refs]) => ({ filename, refs, buffer: fs.readFileSync(filename) })),
        };
    }

    private loadArchive(buffer: Uint8Array) {
        // Keep archive paths intact: resource paths are relative to the metadata, not the ZIP root.
        const { paths, metaPath, metadata } = readZipMetadata(buffer, 'LCC2');
        const meta: Metadata = JSON.parse(new TextDecoder().decode(metadata));
        const { splatType, selected } = this.collectFiles(meta, name => {
            const candidates = [
                resolveArchivePath(metaPath, name),
                name,
                resolveArchivePath(metaPath, path.posix.basename(name)),
            ];
            return candidates.map(candidate => paths.get(candidate)).find(candidate => candidate !== undefined);
        });

        // Only inflate LOD0 resources and the environment; skip coarser LODs and mesh data.
        const entries = readZipEntries(buffer, selected.keys());
        return {
            splatType,
            files: [...selected].map(([filename, refs]) => ({ filename, refs, buffer: entries[filename] })),
        };
    }

    private collectFiles(meta: Metadata, resolveFile: (name: string) => string | undefined) {
        if (meta.version !== undefined && !/^0\.0\.[1-3]$/.test(meta.version)) {
            throw new Error(`Unsupported LCC2 version: ${meta.version}`);
        }
        const totalLevels = meta.totalLevels ?? meta.lod_level ?? 0;
        if (!Number.isSafeInteger(totalLevels) || totalLevels < 1) {
            throw new Error(`Invalid LCC2 totalLevels: ${totalLevels}`);
        }
        const splatType = (meta.splatType ?? '.sog').toLowerCase().replace(/^\./, '');
        const type = SplatFileType[splatType.toUpperCase() as keyof typeof SplatFileType];
        if (typeof type !== 'number' || type === SplatFileType.LCC || type === SplatFileType.LCC2) {
            throw new Error(`Unsupported LCC2 splat type: ${splatType}`);
        }
        const files = meta.root?.splatFiles ?? meta.root?.files;
        if (!Array.isArray(files)) {
            throw new Error('LCC2 metadata is missing the splat file list.');
        }

        const selected = new Map<string, SplatRef[]>();
        const add = (ref: SplatRef) => {
            if (!Number.isSafeInteger(ref.name) || ref.name < 0 || typeof files[ref.name] !== 'string') {
                throw new Error(`Invalid LCC2 splat file index: ${ref.name}`);
            }
            let name = normalizeArchivePath(files[ref.name]);
            if (!meta.root.splatFiles && !name.toLowerCase().endsWith(`.${splatType}`)) {
                name += `.${splatType}`;
            }
            const filename = resolveFile(name);
            if (filename === undefined) {
                throw new Error(`LCC2 splat file not found: ${files[ref.name]}`);
            }
            const refs = selected.get(filename) ?? [];
            refs.push(ref);
            selected.set(filename, refs);
        };
        const env = meta.root.data?.env;
        const visit = (node: Lcc2Node, depth: number) => {
            const ref = node.data?.['3dgs'];
            if (depth === totalLevels && ref && ref.name !== env?.name) {
                add(ref);
            }
            if (depth < totalLevels) {
                for (const child of Object.values(node.child ?? {})) {
                    visit(child, depth + 1);
                }
            }
        };
        visit(meta.root, 0);
        if (selected.size === 0) {
            throw new Error('No splat files found for LCC2 LOD0.');
        }
        if (env) {
            add(env);
        }

        return { splatType, selected };
    }

    async read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData) {
        const buffer = new Uint8Array(contentLength);
        const reader = stream.getReader();
        let readOffset = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer.set(value!, readOffset);
            readOffset += value!.length;
        }
        const { files, splatType } = this.load(buffer);
        const initialized = deferred();
        initialized.promise.catch(() => {});
        let pending = files.length;
        let counts = 0;
        let shDegree = 0;
        let blockOffset = 0;
        const promises: Array<Promise<void>> = [];
        for (let i = 0; i < files.length; i++) {
            const { filename, refs, buffer } = files[i];
            const splat = new SplatData(1, data.maxShDegree);
            const initBlock = splat.initBlock.bind(splat) as SplatData['initBlock'];
            let ranges: SplatRange[] = [];
            splat.initBlock = async (blockCounts, blockShDegree) => {
                ranges = collectRanges(refs, blockCounts, filename);
                counts += ranges.reduce((sum, range) => sum + range.end - range.start, 0);
                shDegree = Math.max(shDegree, blockShDegree);
                // Scan headers before allocating the output, then decode one file at a time.
                if (--pending === 0) {
                    blockOffset = await data.initBlock(counts, shDegree);
                    initialized.resolve();
                }
                await initialized.promise;
                if (i > 0) {
                    await promises[i - 1];
                }
                return initBlock(blockCounts, blockShDegree);
            };

            const stream = Readable.toWeb(Readable.from([buffer])) as ReadableStream<Uint8Array>;
            const promise = createSplatFile(`chunk.${splatType}`)
                .read(stream, buffer.length, splat)
                .then(() => {
                    const columns = Math.min(splat.table.length, data.table.length);
                    for (const { start, end } of ranges) {
                        for (let column = 0; column < columns; column++) {
                            data.table[column].set(splat.table[column].subarray(start, end), blockOffset);
                        }
                        // Higher SH columns stay zero for resources with a lower SH degree.
                        blockOffset += end - start;
                    }
                })
                .finally(() => splat.init(0, 0));
            promises.push(promise);
        }
        try {
            await Promise.all(promises);
        } catch (error) {
            initialized.reject(error);
            await Promise.allSettled(promises);
            throw error;
        }
        data.finishBlock();
    }

    async write(_stream: WritableStream<Uint8Array>, _data: SplatData, _indices: Uint32Array) {
        throw new Error('Method not implemented.');
    }
}
