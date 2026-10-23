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
    /** Global index from enumerateAdapters(), shared across graphics APIs. */
    gpu?: number;
    /** Positive worker count; capped at max(1, hardware_concurrency() - 1). Omit for automatic sizing. */
    cpuWorkers?: number;
    tasks: PipelineTask[];
}

/** Serialized values must match gpu::ApiType in the native executable. */
export enum ApiType {
    Vulkan = 0,
}

export interface DeviceInfo {
    /** Zero-based index across all APIs in this enumeration. */
    index: number;
    name: string;
    api: ApiType;
    /** API-specific raw version supported by the device; decode according to api. */
    apiVersion: number;
    vendorId: number;
    deviceId: number;
    /** Backend-reported identifier; use index for device selection. */
    uuid: string;
}
