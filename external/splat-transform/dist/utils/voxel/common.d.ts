/** 3D Morton (Z-order) for integer block coordinates. */
export declare const encodeMorton3: (x: number, y: number, z: number) => number;
export declare const decodeMorton3: (m: number) => [number, number, number];
export interface Bounds {
    min: {
        x: number;
        y: number;
        z: number;
    };
    max: {
        x: number;
        y: number;
        z: number;
    };
}
/** Voxel leaf edge length in voxels (4³ block). */
export declare const LEAF_SIZE = 4;
export declare const ALPHA_THRESHOLD: number;
export declare const alignGridBounds: (bounds: Bounds, voxelResolution: number) => Bounds;
/** Opacity-aware AABB half-extents from scale + unit quaternion. */
export declare const extentsFromQuatScale: (sx: number, sy: number, sz: number, qx: number, qy: number, qz: number, qw: number, opacity?: number, opacityThreshold?: number) => {
    ex: number;
    ey: number;
    ez: number;
};
export declare class GaussianBVH {
    private static readonly MAX_LEAF_SIZE;
    private readonly x;
    private readonly y;
    private readonly z;
    private readonly extents;
    private readonly root;
    constructor(x: Float32Array, y: Float32Array, z: Float32Array, extents: Float32Array);
    queryOverlappingRaw(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number[];
    queryOverlappingRawInto(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, output: Uint32Array, offset?: number): number;
    private computeBounds;
    private buildNode;
    private queryNode;
    private queryNodeInto;
}
declare const SOLID_LO: number;
declare const SOLID_HI: number;
/**
 * Append-only buffer for streaming voxelization results.
 * Stores (linear blockIdx, voxel mask) pairs for non-empty 4x4x4 blocks.
 *
 * Block keys are linear block indices `bx + by*nbx + bz*nbx*nby` in the
 * producer's grid coordinate system. Producers and consumers must agree on
 * the grid dimensions; the buffer itself is dimension-agnostic.
 */
export declare class BlockMaskBuffer {
    private solidIdx;
    private solidCountValue;
    private solidCap;
    private mixedIdx;
    private mixedCountValue;
    private mixedCap;
    private mixedMasks;
    addBlock(blockIdx: number, lo: number, hi: number): void;
    getMixedBlocks(): {
        blockIdx: Float64Array<ArrayBufferLike>;
        masks: Uint32Array<ArrayBufferLike>;
    };
    getSolidBlocks(): Float64Array<ArrayBufferLike>;
    get count(): number;
    get mixedCount(): number;
    get solidCount(): number;
    clear(): void;
}
declare const BLOCK_EMPTY = 0;
declare const BLOCK_SOLID = 1;
declare const BLOCK_MIXED = 2;
declare const TYPE_MASK = 3;
declare const BLOCKS_PER_WORD = 16;
declare const EVEN_BITS: number;
declare const readBlockType: (types: Uint32Array, blockIdx: number) => number;
declare const writeBlockType: (types: Uint32Array, blockIdx: number, blockType: number) => void;
declare class BlockMaskMap {
    keys: Int32Array;
    lo: Uint32Array;
    hi: Uint32Array;
    private _size;
    private _capacity;
    private _mask;
    constructor(initialCapacity?: number);
    slot(key: number): number;
    set(key: number, loVal: number, hiVal: number): void;
    removeAt(slot: number): void;
    clear(): void;
    get size(): number;
    releaseStorage(): void;
    clone(): BlockMaskMap;
    private _grow;
}
declare class SparseVoxelGrid {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly nbx: number;
    readonly nby: number;
    readonly nbz: number;
    readonly bStride: number;
    types: Uint32Array;
    masks: BlockMaskMap;
    constructor(nx: number, ny: number, nz: number);
    getVoxel(ix: number, iy: number, iz: number): number;
    setVoxel(ix: number, iy: number, iz: number): void;
    orBlock(blockIdx: number, lo: number, hi: number): void;
    clear(): void;
    releaseStorage(): void;
    clone(): SparseVoxelGrid;
    cropTo(cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number, onProgress?: (done: number, total: number) => void): SparseVoxelGrid;
    cropToInverted(cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number, onProgress?: (done: number, total: number) => void): SparseVoxelGrid;
    static fromBuffer(acc: BlockMaskBuffer, nx: number, ny: number, nz: number): SparseVoxelGrid;
    toBuffer(cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number, defaultSolid?: boolean): BlockMaskBuffer;
    toBufferInverted(cropMinBx: number, cropMinBy: number, cropMinBz: number, cropMaxBx: number, cropMaxBy: number, cropMaxBz: number): BlockMaskBuffer;
    getOccupiedBlockBounds(onProgress?: (done: number, total: number) => void): {
        minBx: number;
        minBy: number;
        minBz: number;
        maxBx: number;
        maxBy: number;
        maxBz: number;
    } | null;
    getNavigableBlockBounds(onProgress?: (done: number, total: number) => void): {
        minBx: number;
        minBy: number;
        minBz: number;
        maxBx: number;
        maxBy: number;
        maxBz: number;
    } | null;
    static findNearestFreeCell(blocked: SparseVoxelGrid, seedIx: number, seedIy: number, seedIz: number, maxRadius: number): {
        ix: number;
        iy: number;
        iz: number;
    } | null;
}
export declare const SOLID_LEAF_MARKER: number;
export declare const getChildOffset: (mask: number, octant: number) => number;
interface BuildSparseOctreeOptions {
    consumeGrid?: boolean;
    dense?: boolean;
}
/**
 * Build a sparse octree from block masks using:
 * 1) mixed+solid SoA merge and Morton sort
 * 2) bottom-up level construction by parent Morton grouping
 * 3) BFS flatten to node/leafData arrays.
 */
export declare const buildSparseOctree: (grid: SparseVoxelGrid, gridBounds: Bounds, sceneBounds: Bounds, voxelResolution: number, options?: BuildSparseOctreeOptions) => {
    gridBounds: Bounds;
    sceneBounds: Bounds;
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodes: Uint32Array<ArrayBuffer>;
    leafData: Uint32Array<ArrayBuffer>;
};
export { BLOCK_EMPTY, BLOCK_SOLID, BLOCK_MIXED, BLOCKS_PER_WORD, TYPE_MASK, EVEN_BITS, readBlockType, writeBlockType, SOLID_LO, SOLID_HI, SparseVoxelGrid };
