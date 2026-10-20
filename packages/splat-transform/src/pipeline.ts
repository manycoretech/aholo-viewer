export type TaskType =
    | 'Read'
    | 'Write'
    | 'Modify'
    | 'Select'
    | 'ReplaceAppend'
    | 'ExtractLodLevel'
    | 'SkeletonLod'
    | 'FlexLod'
    | 'AutoLod'
    | 'AutoChunkLod'
    | 'SplitSplatTask'
    | 'Voxel';

/** Optional extensions to Modify; output remains an alias of the modified input. */
export interface ModifyConfig extends Record<string, unknown> {
    input: string;
    output: string;
    modifyPaths?: string[];
    /** Internal RGBA values; no clamping or color-space conversion. */
    rgba?: [number, number, number, number];
    /** Truncate existing SH bands without creating higher bands. */
    maxShDegree?: 0 | 1 | 2 | 3;
}

/** Stable first-occurrence selection into an independent splat resource. */
export type SelectConfig = {
    input: string;
    output: string;
} & ({ indices: number[]; indicesPath?: never } | { indicesPath: string; indices?: never });

/** Replace indexed points with the patch prefix, then append its remainder. */
export interface ReplaceAppendConfig extends Record<string, unknown> {
    input: string;
    patch: string;
    output: string;
    sourceIndices: number[];
}

/** Copy metadata intervals from an in-memory LOD bundle in tree order. */
export interface ExtractLodLevelConfig extends Record<string, unknown> {
    input: string;
    output: string;
    /** Required zero-based level; no implicit level 3 default. */
    level: number;
}

/** Voxel generation and navigation use the selected backend throughout. */
export interface VoxelConfig extends Record<string, unknown> {
    input: string;
    output: string;
    /** Defaults to gpu; initialization failure selects CPU for the complete task. Explicit CPU does not initialize Vulkan. */
    backend?: 'cpu' | 'gpu';
    voxelResolution?: number;
    opacityCutoff?: number;
}

/** JSON task configuration consumed by the standalone executable. */
export interface PipelineTask {
    id: string;
    type: TaskType;
    config: Record<string, unknown>;
    release?: string[];
}

export interface PipelineConfig {
    version: 1;
    /** Index from enumerateAdapters(); indices belong to the Vulkan backend. */
    gpu?: number;
    tasks: PipelineTask[];
}

export interface VulkanAdapter {
    index: number;
    name: string;
    backend: 'vulkan';
    vendorId: number;
    deviceId: number;
    apiVersion: number;
    uuid: string;
}
