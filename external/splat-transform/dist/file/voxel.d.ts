/**
 * Portions of this voxel pipeline are adapted from:
 * https://github.com/playcanvas/splat-transform
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 * Licensed under the MIT License.
 */
import { SplatData } from '../SplatData.js';
import { type NavSeed } from '../utils/voxel/nav.js';
import { type CollisionMeshShape } from '../utils/voxel/mesh.js';
type VoxelBackend = 'cpu' | 'gpu';
type CollisionMeshOption = boolean | CollisionMeshShape;
interface BoundsBox {
    minCorner: [number, number, number];
    maxCorner: [number, number, number];
}
export declare function writeVoxelFiles(outputDir: string, data: SplatData, options?: {
    voxelResolution?: number;
    opacityCutoff?: number;
    backend?: VoxelBackend;
    collisionMesh?: CollisionMeshOption;
    navExteriorRadius?: number;
    floorFill?: boolean;
    floorFillDilation?: number;
    cpuWorkerCount?: number;
    box?: BoundsBox;
    navCapsule?: {
        height: number;
        radius: number;
    };
    navSeed?: NavSeed;
}): Promise<void>;
export declare const voxelUtils: {
    getChildOffset: (mask: number, octant: number) => number;
    encodeMorton3: (x: number, y: number, z: number) => number;
    decodeMorton3: (m: number) => [number, number, number];
};
export {};
