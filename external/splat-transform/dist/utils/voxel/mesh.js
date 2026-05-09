import { coplanarMerge } from './coplanar-merge.js';
import { marchingCubes } from './marching-cubes.js';
import { voxelFaces } from './voxel-faces.js';
import { logger } from '../Logger.js';
const encodeGlb = (positions, indices) => {
    const vertexCount = positions.length / 3;
    const indexCount = indices.length;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (x < minX) {
            minX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z > maxZ) {
            maxZ = z;
        }
    }
    const positionsByteLength = positions.byteLength;
    const indicesByteLength = indices.byteLength;
    const totalBinSize = positionsByteLength + indicesByteLength;
    const gltf = {
        asset: { version: '2.0', generator: 'splat-transform' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            {
                bufferView: 0,
                componentType: 5126,
                count: vertexCount,
                type: 'VEC3',
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            },
            {
                bufferView: 1,
                componentType: 5125,
                count: indexCount,
                type: 'SCALAR'
            }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positionsByteLength, target: 34962 },
            { buffer: 0, byteOffset: positionsByteLength, byteLength: indicesByteLength, target: 34963 }
        ],
        buffers: [{ byteLength: totalBinSize }]
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
    const jsonChunkLength = jsonBytes.length + jsonPadding;
    const binPadding = (4 - (totalBinSize % 4)) % 4;
    const binChunkLength = totalBinSize + binPadding;
    const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    view.setUint32(offset, 0x46546C67, true);
    offset += 4;
    view.setUint32(offset, 2, true);
    offset += 4;
    view.setUint32(offset, totalLength, true);
    offset += 4;
    view.setUint32(offset, jsonChunkLength, true);
    offset += 4;
    view.setUint32(offset, 0x4E4F534A, true);
    offset += 4;
    bytes.set(jsonBytes, offset);
    offset += jsonBytes.length;
    for (let i = 0; i < jsonPadding; i++) {
        bytes[offset++] = 0x20;
    }
    view.setUint32(offset, binChunkLength, true);
    offset += 4;
    view.setUint32(offset, 0x004E4942, true);
    offset += 4;
    bytes.set(new Uint8Array(positions.buffer, positions.byteOffset, positionsByteLength), offset);
    offset += positionsByteLength;
    bytes.set(new Uint8Array(indices.buffer, indices.byteOffset, indicesByteLength), offset);
    return bytes;
};
export const buildCollisionMesh = (grid, gridBounds, voxelResolution, shape = 'smooth') => {
    const nx = Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution);
    const ny = Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution);
    const nz = Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution);
    if (nx % 4 !== 0 || ny % 4 !== 0 || nz % 4 !== 0) {
        return undefined;
    }
    logger.time('Build collision mesh');
    let mesh;
    if (shape === 'faces') {
        mesh = voxelFaces(grid, gridBounds, voxelResolution);
        logger.info(`collision mesh faces: ${mesh.positions.length / 3} vertices, ${mesh.indices.length / 3} triangles`);
    }
    else {
        const preMerged = marchingCubes(grid, gridBounds, voxelResolution, { mergeFlatFaces: true });
        logger.info(`collision mesh pre-merged: ${preMerged.positions.length / 3} vertices, ${preMerged.indices.length / 3} triangles`);
        if (preMerged.indices.length < 3) {
            mesh = preMerged;
        }
        else {
            mesh = coplanarMerge(preMerged, voxelResolution);
            const reduction = (1 - mesh.indices.length / preMerged.indices.length) * 100;
            logger.info(`collision mesh merged: ${mesh.positions.length / 3} vertices, ${mesh.indices.length / 3} triangles`);
            logger.info(`collision mesh reduction: ${reduction.toFixed(0)}%`);
        }
    }
    logger.timeEnd('Build collision mesh');
    if (mesh.indices.length < 3) {
        logger.warn('collision mesh: no triangles generated, skipping GLB output');
        return undefined;
    }
    return encodeGlb(mesh.positions, mesh.indices);
};
