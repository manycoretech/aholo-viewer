import { SplatData } from '../SplatData.js';
import { writeVoxelFiles } from '../file/voxel.js';
import { BaseTask } from './BaseTask.js';
export class VoxelTask extends BaseTask {
    async exec(config, { logger, resources }) {
        const { input, output, voxelResolution = 0.05, opacityCutoff = 0.1, backend = 'gpu', collisionMesh = false, navExteriorRadius, floorFill = false, floorFillDilation = 0, cpuWorkerCount = -1, box = { minCorner: [-100, -100, -100], maxCorner: [100, 100, 100] }, navCapsule, navSeed } = config;
        const source = resources.get(input);
        if (!(source instanceof SplatData)) {
            throw new Error(`VoxelTask: resource "${input}" must be SplatData`);
        }
        const options = {
            voxelResolution,
            opacityCutoff,
            backend,
            collisionMesh,
            floorFill,
            floorFillDilation,
            cpuWorkerCount,
            box
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
    requiresGPU(_config) {
        return (_config.backend ?? 'gpu') === 'gpu';
    }
}
