import { SparseVoxelGrid, type Bounds } from './common.js';
export type CollisionMeshShape = 'smooth' | 'faces';
export declare const buildCollisionMesh: (grid: SparseVoxelGrid, gridBounds: Bounds, voxelResolution: number, shape?: CollisionMeshShape) => Uint8Array | undefined;
