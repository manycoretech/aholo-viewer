import { popcount } from './common.js';

const SOLID_LEAF_MARKER = 0xff000000 >>> 0;
const COMPACT_MAGIC = 0x31424356; // "VCB1" little-endian
const COMPACT_VERSION = 1;
const HEADER_UINT32_COUNT = 8;
const HEADER_BYTES = HEADER_UINT32_COUNT * 4;

const TAG_MIXED = 0;
const TAG_SOLID = 1;
const TAG_INTERNAL = 2;

export type VoxelNodeEncoding = 'raw' | 'compact';

export interface DecodedVoxelBinary {
    nodes: Uint32Array;
    leafData: Uint32Array;
}

function getTagByteLength(nodeCount: number): number {
    return Math.ceil(nodeCount / 4);
}

function align4(value: number): number {
    return (value + 3) & ~3;
}

function writeTag(tags: Uint8Array, index: number, tag: number): void {
    const shift = (index & 3) << 1;
    tags[index >> 2] = (tags[index >> 2] & ~(0x3 << shift)) | ((tag & 0x3) << shift);
}

function readTag(tags: Uint8Array, index: number): number {
    const shift = (index & 3) << 1;
    return (tags[index >> 2] >>> shift) & 0x3;
}

function toUint8Array(data: Uint8Array): Uint8Array {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeRawVoxelBinary(nodes: Uint32Array, leafData: Uint32Array): Uint8Array {
    const binary = new Uint8Array((nodes.length + leafData.length) * 4);
    const view = new Uint32Array(binary.buffer);
    view.set(nodes, 0);
    view.set(leafData, nodes.length);
    return binary;
}

export function encodeCompactVoxelBinary(
    nodes: Uint32Array,
    leafData: Uint32Array,
    numInteriorNodes: number,
    numMixedLeaves: number,
): Uint8Array {
    const nodeCount = nodes.length;
    const tagBytes = getTagByteLength(nodeCount);
    const tags = new Uint8Array(tagBytes);
    const childMasks = new Uint8Array(numInteriorNodes);
    let interiorCursor = 0;
    let mixedCursor = 0;

    for (let i = 0; i < nodeCount; i++) {
        const node = nodes[i] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            writeTag(tags, i, TAG_SOLID);
            continue;
        }
        const childMask = node >>> 24;
        if (childMask === 0) {
            const leafDataIndex = node & 0x00ffffff;
            if (leafDataIndex !== mixedCursor) {
                throw new Error(
                    `compact voxel encoding requires mixed leaf indices to be BFS-sequential: ` +
                        `node ${i} has ${leafDataIndex}, expected ${mixedCursor}`,
                );
            }
            writeTag(tags, i, TAG_MIXED);
            mixedCursor++;
            continue;
        }
        if (childMask === 0xff && (node & 0x00ffffff) === 0) {
            throw new Error(`invalid voxel node ${i}: solid sentinel must be encoded as 0xFF000000`);
        }
        writeTag(tags, i, TAG_INTERNAL);
        if (interiorCursor >= childMasks.length) {
            throw new Error(`compact voxel encoding found more interior nodes than metadata (${numInteriorNodes})`);
        }
        childMasks[interiorCursor++] = childMask;
    }

    if (interiorCursor !== numInteriorNodes) {
        throw new Error(`compact voxel encoding interior count mismatch: ${interiorCursor} !== ${numInteriorNodes}`);
    }
    if (mixedCursor !== numMixedLeaves) {
        throw new Error(`compact voxel encoding mixed leaf count mismatch: ${mixedCursor} !== ${numMixedLeaves}`);
    }

    const leafBytes = toUint8Array(new Uint8Array(leafData.buffer, leafData.byteOffset, leafData.byteLength));
    const leafOffset = align4(HEADER_BYTES + tagBytes + childMasks.byteLength);
    const binary = new Uint8Array(leafOffset + leafBytes.byteLength);
    const header = new DataView(binary.buffer, 0, HEADER_BYTES);
    header.setUint32(0, COMPACT_MAGIC, true);
    header.setUint32(4, COMPACT_VERSION, true);
    header.setUint32(8, nodeCount, true);
    header.setUint32(12, numInteriorNodes, true);
    header.setUint32(16, numMixedLeaves, true);
    header.setUint32(20, leafData.length, true);
    header.setUint32(24, tagBytes, true);
    header.setUint32(28, childMasks.byteLength, true);
    binary.set(tags, HEADER_BYTES);
    binary.set(childMasks, HEADER_BYTES + tagBytes);
    binary.set(leafBytes, leafOffset);
    return binary;
}

export function decodeCompactVoxelBinary(binary: Uint8Array): DecodedVoxelBinary {
    if (binary.byteLength < HEADER_BYTES) {
        throw new Error('compact voxel binary is too small for header');
    }
    const header = new DataView(binary.buffer, binary.byteOffset, HEADER_BYTES);
    const magic = header.getUint32(0, true);
    const version = header.getUint32(4, true);
    if (magic !== COMPACT_MAGIC) {
        throw new Error(`invalid compact voxel magic 0x${magic.toString(16)}`);
    }
    if (version !== COMPACT_VERSION) {
        throw new Error(`unsupported compact voxel version ${version}`);
    }
    const nodeCount = header.getUint32(8, true);
    const numInteriorNodes = header.getUint32(12, true);
    const numMixedLeaves = header.getUint32(16, true);
    const leafDataCount = header.getUint32(20, true);
    const tagBytes = header.getUint32(24, true);
    const childMaskBytes = header.getUint32(28, true);
    if (tagBytes !== getTagByteLength(nodeCount)) {
        throw new Error(`compact voxel tag byte count mismatch: ${tagBytes} !== ${getTagByteLength(nodeCount)}`);
    }
    if (childMaskBytes !== numInteriorNodes) {
        throw new Error(`compact voxel child-mask byte count mismatch: ${childMaskBytes} !== ${numInteriorNodes}`);
    }
    const leafOffset = align4(HEADER_BYTES + tagBytes + childMaskBytes);
    const expectedBytes = leafOffset + leafDataCount * 4;
    if (binary.byteLength !== expectedBytes) {
        throw new Error(`compact voxel byte length mismatch: ${binary.byteLength} !== ${expectedBytes}`);
    }

    const tags = new Uint8Array(binary.buffer, binary.byteOffset + HEADER_BYTES, tagBytes);
    const childMasks = new Uint8Array(binary.buffer, binary.byteOffset + HEADER_BYTES + tagBytes, childMaskBytes);
    const leafData = new Uint32Array(leafDataCount);
    leafData.set(new Uint32Array(binary.buffer, binary.byteOffset + leafOffset, leafDataCount));

    const nodes = new Uint32Array(nodeCount);
    let levelStart = 0;
    let levelEnd = nodeCount > 0 ? 1 : 0;
    let childStart = levelEnd;
    let interiorCursor = 0;
    let mixedCursor = 0;

    while (levelStart < levelEnd) {
        let nextLevelEnd = childStart;
        for (let i = levelStart; i < levelEnd; i++) {
            const tag = readTag(tags, i);
            if (tag === TAG_SOLID) {
                nodes[i] = SOLID_LEAF_MARKER;
            } else if (tag === TAG_MIXED) {
                nodes[i] = mixedCursor++;
            } else if (tag === TAG_INTERNAL) {
                if (interiorCursor >= childMasks.length) {
                    throw new Error('compact voxel decode exhausted child masks');
                }
                const childMask = childMasks[interiorCursor++];
                nodes[i] = ((childMask << 24) | childStart) >>> 0;
                childStart += popcount(childMask);
                nextLevelEnd = childStart;
                if (childStart > nodeCount) {
                    throw new Error(`compact voxel child range exceeds node count (${childStart} > ${nodeCount})`);
                }
            } else {
                throw new Error(`compact voxel decode found reserved node tag ${tag} at node ${i}`);
            }
        }
        levelStart = levelEnd;
        levelEnd = nextLevelEnd;
    }

    if (levelEnd !== nodeCount) {
        throw new Error(`compact voxel decode did not consume all nodes: ${levelEnd} !== ${nodeCount}`);
    }
    if (interiorCursor !== numInteriorNodes) {
        throw new Error(`compact voxel decode interior count mismatch: ${interiorCursor} !== ${numInteriorNodes}`);
    }
    if (mixedCursor !== numMixedLeaves) {
        throw new Error(`compact voxel decode mixed leaf count mismatch: ${mixedCursor} !== ${numMixedLeaves}`);
    }
    return { nodes, leafData };
}
