import { SplatData } from '../SplatData.js';
import { writeVoxelFiles, type AutoDenseBoxConfig, type VoxelBinaryCompression } from '../file/voxel.js';
import type { FilterClusterOptions } from '../utils/voxel/filter-cluster.js';
import type { VoxelNodeEncoding } from '../utils/voxel/binary.js';
import { type Context, BaseTask } from './BaseTask.js';

export interface VoxelTaskConfig {
    input: string;
    output: string;
    voxelResolution?: number;
    opacityCutoff?: number;
    backend?: 'cpu' | 'gpu';
    collisionMesh?: boolean | 'smooth' | 'faces';
    navExteriorRadius?: number;
    floorFill?: boolean;
    floorFillDilation?: number;
    cpuWorkerCount?: number;
    box?: { minCorner: [number, number, number]; maxCorner: [number, number, number] };
    navCapsule?: { height: number; radius: number };
    navSeed?: { x: number; y: number; z: number };
    compression?: VoxelBinaryCompression;
    nodeEncoding?: VoxelNodeEncoding;
    filterCluster?: boolean | FilterClusterOptions;
    autoDenseBox?: AutoDenseBoxConfig;
}

export class VoxelTask extends BaseTask<VoxelTaskConfig> {
    override async exec(config: VoxelTaskConfig, { logger, resources }: Context) {
        const {
            input,
            output,
            voxelResolution = 0.05,
            opacityCutoff = 0.1,
            backend = 'gpu',
            collisionMesh = false,
            navExteriorRadius,
            floorFill = false,
            floorFillDilation = 0,
            cpuWorkerCount = -1,
            box = { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] },
            navCapsule,
            navSeed,
            compression = 'none',
            nodeEncoding = 'raw',
            filterCluster = true,
            autoDenseBox = true,
        } = config;
        const source = resources.get(input)!;
        if (!(source instanceof SplatData)) {
            throw new Error(`VoxelTask: resource "${input}" must be SplatData`);
        }
        const options: Parameters<typeof writeVoxelFiles>[2] = {
            voxelResolution,
            opacityCutoff,
            backend,
            collisionMesh,
            floorFill,
            floorFillDilation,
            cpuWorkerCount,
            box,
            compression,
            nodeEncoding,
            filterCluster,
            autoDenseBox,
        };
        if (navExteriorRadius !== undefined) {
            options.navExteriorRadius = navExteriorRadius;
        }
        if (navCapsule !== undefined) {
            options.navCapsule = navCapsule;
        }
        if (navSeed !== undefined) {
            options.navSeed = navSeed;
        }
        logger.info(`writing voxel -> dir="${output}" count=${source.counts} SH=${source.shDegree}`);
        await writeVoxelFiles(output, source, options);
        logger.info('voxelizing done');
    }

    override requiresGPU(_config: VoxelTaskConfig): boolean {
        return (_config.backend ?? 'gpu') === 'gpu';
    }
}
