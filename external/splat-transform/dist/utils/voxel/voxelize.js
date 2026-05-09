import { getOrCreateDevice } from '../webgpu.js';
import { ALPHA_THRESHOLD, BlockMaskBuffer, GaussianBVH, LEAF_SIZE } from './common.js';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
/** Per gaussian: increment overlap count for each coarse batch cell its AABB touches (GPU atomics). */
const buildPerBatchCountsWgsl = () => /* wgsl */ `
struct Uniforms {
    gridMinX: f32,
    gridMinY: f32,
    gridMinZ: f32,
    batchWorldSize: f32,
    numBatchX: u32,
    numBatchY: u32,
    numBatchZ: u32,
    gaussianCount: u32
}

struct Gaussian {
    posX: f32, posY: f32, posZ: f32, opacity: f32,
    rotW: f32, rotX: f32, rotY: f32, rotZ: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32,
    extentX: f32, extentY: f32, extentZ: f32,
    _padding0: f32, _padding1: f32
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> allGaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read_write> batchCounts: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let gaussianIdx = global_id.x;
    if (gaussianIdx >= uniforms.gaussianCount) { return; }
    let g = allGaussians[gaussianIdx];
    if (g.opacity <= 0.0) { return; }
    let gMinX = g.posX - g.extentX - uniforms.gridMinX;
    let gMinY = g.posY - g.extentY - uniforms.gridMinY;
    let gMinZ = g.posZ - g.extentZ - uniforms.gridMinZ;
    let gMaxX = g.posX + g.extentX - uniforms.gridMinX;
    let gMaxY = g.posY + g.extentY - uniforms.gridMinY;
    let gMaxZ = g.posZ + g.extentZ - uniforms.gridMinZ;
    let maxWorldX = uniforms.batchWorldSize * f32(uniforms.numBatchX);
    let maxWorldY = uniforms.batchWorldSize * f32(uniforms.numBatchY);
    let maxWorldZ = uniforms.batchWorldSize * f32(uniforms.numBatchZ);
    if (gMaxX < 0.0 || gMinX > maxWorldX || gMaxY < 0.0 || gMinY > maxWorldY || gMaxZ < 0.0 || gMinZ > maxWorldZ) { return; }
    let minBx = clamp(i32(floor(gMinX / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchX) - 1);
    let minBy = clamp(i32(floor(gMinY / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchY) - 1);
    let minBz = clamp(i32(floor(gMinZ / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchZ) - 1);
    let maxBx = clamp(i32(floor(gMaxX / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchX) - 1);
    let maxBy = clamp(i32(floor(gMaxY / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchY) - 1);
    let maxBz = clamp(i32(floor(gMaxZ / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchZ) - 1);
    for (var bz = minBz; bz <= maxBz; bz++) {
        for (var by = minBy; by <= maxBy; by++) {
            for (var bx = minBx; bx <= maxBx; bx++) {
                let batchId = u32(bz) * uniforms.numBatchX * uniforms.numBatchY + u32(by) * uniforms.numBatchX + u32(bx);
                atomicAdd(&batchCounts[batchId], 1u);
            }
        }
    }
}
`;
/** Scatter gaussian indices into packed `indices` using prefix `batchOffsets` and per-batch atomic write heads. */
const fillPerBatchCandidatesWgsl = () => /* wgsl */ `
struct Uniforms {
    gridMinX: f32,
    gridMinY: f32,
    gridMinZ: f32,
    batchWorldSize: f32,
    numBatchX: u32,
    numBatchY: u32,
    numBatchZ: u32,
    gaussianCount: u32
}

struct Gaussian {
    posX: f32, posY: f32, posZ: f32, opacity: f32,
    rotW: f32, rotX: f32, rotY: f32, rotZ: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32,
    extentX: f32, extentY: f32, extentZ: f32,
    _padding0: f32, _padding1: f32
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> allGaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> batchOffsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> batchWriteHeads: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> indices: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let gaussianIdx = global_id.x;
    if (gaussianIdx >= uniforms.gaussianCount) { return; }
    let g = allGaussians[gaussianIdx];
    if (g.opacity <= 0.0) { return; }
    let gMinX = g.posX - g.extentX - uniforms.gridMinX;
    let gMinY = g.posY - g.extentY - uniforms.gridMinY;
    let gMinZ = g.posZ - g.extentZ - uniforms.gridMinZ;
    let gMaxX = g.posX + g.extentX - uniforms.gridMinX;
    let gMaxY = g.posY + g.extentY - uniforms.gridMinY;
    let gMaxZ = g.posZ + g.extentZ - uniforms.gridMinZ;
    let maxWorldX = uniforms.batchWorldSize * f32(uniforms.numBatchX);
    let maxWorldY = uniforms.batchWorldSize * f32(uniforms.numBatchY);
    let maxWorldZ = uniforms.batchWorldSize * f32(uniforms.numBatchZ);
    if (gMaxX < 0.0 || gMinX > maxWorldX || gMaxY < 0.0 || gMinY > maxWorldY || gMaxZ < 0.0 || gMinZ > maxWorldZ) { return; }
    let minBx = clamp(i32(floor(gMinX / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchX) - 1);
    let minBy = clamp(i32(floor(gMinY / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchY) - 1);
    let minBz = clamp(i32(floor(gMinZ / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchZ) - 1);
    let maxBx = clamp(i32(floor(gMaxX / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchX) - 1);
    let maxBy = clamp(i32(floor(gMaxY / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchY) - 1);
    let maxBz = clamp(i32(floor(gMaxZ / uniforms.batchWorldSize)), 0, i32(uniforms.numBatchZ) - 1);
    for (var bz = minBz; bz <= maxBz; bz++) {
        for (var by = minBy; by <= maxBy; by++) {
            for (var bx = minBx; bx <= maxBx; bx++) {
                let batchId = u32(bz) * uniforms.numBatchX * uniforms.numBatchY + u32(by) * uniforms.numBatchX + u32(bx);
                let local = atomicAdd(&batchWriteHeads[batchId], 1u);
                let dst = batchOffsets[batchId] + local;
                indices[dst] = gaussianIdx;
            }
        }
    }
}
`;
/**
 * From https://github.com/playcanvas/splat-transform/blob/8f3b843efdc378f97d4f6a66a3a90a2de6d479a4/src/lib/gpu/gpu-voxelization.ts
 * WGSL shader for multi-batch voxelization of 4x4x4 blocks.
 *
 * Each workgroup processes one block in one batch.
 * - workgroup_id.z = batch index
 * - workgroup_id.x = flat block index within the batch
 * Per-batch metadata (index range, block origin, dimensions) comes from a storage buffer,
 * allowing many batches to be dispatched in a single GPU call.
 */
const voxelizeMultiBatchWgsl = () => /* wgsl */ `
struct Uniforms {
    opacityCutoff: f32,
    voxelResolution: f32,
    maxBlocksPerBatch: u32
}

struct BatchInfo {
    indexOffset: u32,
    indexCount: u32,
    numBlocksX: u32,
    numBlocksY: u32,
    numBlocksZ: u32,
    blockMinX: f32,
    blockMinY: f32,
    blockMinZ: f32
}

struct Gaussian {
    posX: f32,
    posY: f32,
    posZ: f32,
    opacity: f32,
    rotW: f32,
    rotX: f32,
    rotY: f32,
    rotZ: f32,
    scaleX: f32,
    scaleY: f32,
    scaleZ: f32,
    extentX: f32,
    extentY: f32,
    extentZ: f32,
    _padding0: f32,
    _padding1: f32
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> allGaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> results: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> batchInfos: array<BatchInfo>;

// Shared memory for cooperative Gaussian loading.
// All 64 threads in a workgroup load one Gaussian each, then all threads
// evaluate against the shared chunk (reducing global memory reads by 64x).
// 64 Gaussians * 64 bytes each = 4 KB (well within 16 KB WebGPU minimum).
const tileSize = 64u;
var<workgroup> sharedGaussians: array<Gaussian, tileSize>;
var<workgroup> blockMasks: array<atomic<u32>, 2>;

fn mortonToXYZ(m: u32) -> vec3u {
    return vec3u(
        (m & 1u) | ((m >> 2u) & 2u),
        ((m >> 1u) & 1u) | ((m >> 3u) & 2u),
        ((m >> 2u) & 1u) | ((m >> 4u) & 2u)
    );
}

fn evaluateGaussianForVoxel(voxelCenter: vec3f, voxelHalfSize: f32, g: Gaussian) -> f32 {
    let gaussianCenter = vec3f(g.posX, g.posY, g.posZ);
    let diff = voxelCenter - gaussianCenter;
    // Use pre-computed world-space AABB half-extents (3-sigma, accounts for rotation)
    let extent = vec3f(g.extentX, g.extentY, g.extentZ);
    // Per-axis AABB overlap check
    if (any(abs(diff) > (extent + voxelHalfSize))) {
        return 0.0;
    }
    // Find closest point in voxel to Gaussian center
    let closestPoint = clamp(gaussianCenter, voxelCenter - voxelHalfSize, voxelCenter + voxelHalfSize);
    let closestDiff = closestPoint - gaussianCenter;
    // Inverse rotation using cross-product formula (Rodrigues rotation)
    // For inverse: negate xyz components of quaternion
    let qxyz = vec3f(-g.rotX, -g.rotY, -g.rotZ);
    let t = 2.0 * cross(qxyz, closestDiff);
    let localDiff = closestDiff + g.rotW * t + cross(qxyz, t);
    // Calculate Mahalanobis distance squared
    let invScale = vec3f(1.0 / max(g.scaleX, 1e-8), 1.0 / max(g.scaleY, 1e-8), 1.0 / max(g.scaleZ, 1e-8));
    let scaled = localDiff * invScale;
    let d2 = dot(scaled, scaled);
    return g.opacity * exp(-0.5 * d2);
}

@compute @workgroup_size(64)
fn main(
    @builtin(local_invocation_index) local_invocation_index: u32,
    @builtin(workgroup_id) workgroup_id: vec3u
) {
    let batchIdx = workgroup_id.z;
    let flatBlockId = workgroup_id.x;
    let info = batchInfos[batchIdx];
    // Skip padded workgroups beyond the batch's actual block count
    let totalBlocks = info.numBlocksX * info.numBlocksY * info.numBlocksZ;
    if (flatBlockId >= totalBlocks) { return; }

    // Decompose flat block ID to 3D coordinates within the batch
    let blockX = flatBlockId % info.numBlocksX;
    let blockY = (flatBlockId / info.numBlocksX) % info.numBlocksY;
    let blockZ = flatBlockId / (info.numBlocksX * info.numBlocksY);
    let localPos = mortonToXYZ(local_invocation_index);

    let blockMin = vec3f(info.blockMinX, info.blockMinY, info.blockMinZ);
    let blockOffset = vec3f(f32(blockX), f32(blockY), f32(blockZ)) * 4.0 * uniforms.voxelResolution;
    let voxelCenter = blockMin + blockOffset + (vec3f(localPos) + 0.5) * uniforms.voxelResolution;
    let voxelHalfSize = uniforms.voxelResolution * 0.5;
    if (local_invocation_index < 2u) {
        atomicStore(&blockMasks[local_invocation_index], 0u);
    }
    workgroupBarrier();

    var totalSigma = 0.0;
    let numIndices = info.indexCount;
    let numTiles = (numIndices + tileSize - 1u) / tileSize;
    for (var tile = 0u; tile < numTiles; tile++) {
        // Cooperative load: each thread loads one Gaussian into shared memory
        let loadIdx = tile * tileSize + local_invocation_index;
        if (loadIdx < numIndices) {
            let gaussianIdx = indices[info.indexOffset + loadIdx];
            sharedGaussians[local_invocation_index] = allGaussians[gaussianIdx];
        }
        // Wait for all threads to finish loading the tile
        workgroupBarrier();

        if (totalSigma < 7.0) {
            let thisTileSize = min(tileSize, numIndices - tile * tileSize);
            for (var c = 0u; c < thisTileSize; c++) {
                totalSigma += evaluateGaussianForVoxel(voxelCenter, voxelHalfSize, sharedGaussians[c]);
                if (totalSigma >= 7.0) { break; }
            }
        }
        // Wait before next tile overwrites shared memory
        workgroupBarrier();
    }

    // Convert accumulated density to opacity using Beer-Lambert law
    let finalOpacity = 1.0 - exp(-totalSigma);
    let isSolid = finalOpacity >= uniforms.opacityCutoff;
    // Accumulate block bits in workgroup-local atomics first to reduce global atomic contention.
    if (isSolid) {
        let linearIdx = localPos.z * 16u + localPos.y * 4u + localPos.x;
        atomicOr(&blockMasks[linearIdx >> 5u], 1u << (linearIdx & 31u));
    }
    workgroupBarrier();
    if (local_invocation_index < 2u) {
        let batchResultBase = batchIdx * uniforms.maxBlocksPerBatch * 2u;
        let wordIndex = batchResultBase + flatBlockId * 2u + local_invocation_index;
        atomicStore(&results[wordIndex], atomicLoad(&blockMasks[local_invocation_index]));
    }
}
`;
const GPU_BUFFER_USAGE_STORAGE = 128;
const GPU_BUFFER_USAGE_COPY_DST = 8;
const GPU_BUFFER_USAGE_COPY_SRC = 4;
const GPU_BUFFER_USAGE_UNIFORM = 64;
const GPU_BUFFER_USAGE_MAP_READ = 1;
const GPU_MAP_MODE_READ = 1;
/**
 * CPU voxelization fallback (simplified path).
 * Iterates candidate gaussians per batch and writes occupied voxel bits directly.
 */
const CPU_VOXEL_PARALLEL_MIN_GAUSSIANS = 0;
const parsePositiveInteger = (value) => {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};
const resolveCpuVoxelWorkerCount = (override) => {
    if (override !== undefined) {
        if (override === -1) {
            return Math.max(1, availableParallelism() - 1);
        }
        return parsePositiveInteger(override) ?? Math.max(1, availableParallelism() - 1);
    }
    return parsePositiveInteger(process.env.SPLAT_CPU_VOXEL_WORKERS) ??
        parsePositiveInteger(process.env.CPU_VOXEL_WORKERS) ??
        Math.max(1, availableParallelism() - 1);
};
const cpuVoxelizeWorkerScript = `
const { parentPort, workerData } = require('node:worker_threads');
const {
  voxelResolution, opacityCutoff, alphaThreshold, gridMinX, gridMinY, gridMinZ,
  nBlockX, nBlockY, nBlockXY,
  xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents
} = workerData;
const x = new Float32Array(xCol);
const y = new Float32Array(yCol);
const z = new Float32Array(zCol);
const sx = new Float32Array(sxCol);
const sy = new Float32Array(syCol);
const sz = new Float32Array(szCol);
const qx = new Float32Array(qxCol);
const qy = new Float32Array(qyCol);
const qz = new Float32Array(qzCol);
const qw = new Float32Array(qwCol);
const a = new Float32Array(aCol);
const ext = new Float32Array(extents);
const half = voxelResolution * 0.5;
const sigmaCutoff = opacityCutoff <= 0 ? 0 : -Math.log1p(-Math.min(opacityCutoff, 1 - 1e-8));
const SPEC_STRIDE = 8;
const BATCH_BLOCK_SIZE = 4;
const BATCH_VOXEL_SIZE = BATCH_BLOCK_SIZE * 4;
const MAX_BATCH_VOXELS = BATCH_VOXEL_SIZE * BATCH_VOXEL_SIZE * BATCH_VOXEL_SIZE;
const MAX_BATCH_BLOCKS = BATCH_BLOCK_SIZE * BATCH_BLOCK_SIZE * BATCH_BLOCK_SIZE;
const sigmaBuffer = new Float32Array(MAX_BATCH_VOXELS);
const solidBuffer = new Uint8Array(MAX_BATCH_VOXELS);
const masksLoBuffer = new Uint32Array(MAX_BATCH_BLOCKS);
const masksHiBuffer = new Uint32Array(MAX_BATCH_BLOCKS);
const runBatchSet = (batchSpecs, candidateIndices) => {
  const specs = new Uint32Array(batchSpecs);
  const candidates = new Uint32Array(candidateIndices);
  const packedBlocks = [];
  const batchCount = specs.length / SPEC_STRIDE;
  for (let specIdx = 0; specIdx < batchCount; specIdx++) {
    const specBase = specIdx * SPEC_STRIDE;
    const batchBlockX = specs[specBase + 0];
    const batchBlockY = specs[specBase + 1];
    const batchBlockZ = specs[specBase + 2];
    const numBlocksX = specs[specBase + 3];
    const numBlocksY = specs[specBase + 4];
    const numBlocksZ = specs[specBase + 5];
    const indexOffset = specs[specBase + 6];
    const indexCount = specs[specBase + 7];
    const numVoxelsX = numBlocksX * 4;
    const numVoxelsY = numBlocksY * 4;
    const numVoxelsZ = numBlocksZ * 4;
    const totalVoxels = numVoxelsX * numVoxelsY * numVoxelsZ;
    const totalBlocks = numBlocksX * numBlocksY * numBlocksZ;
    sigmaBuffer.fill(0, 0, totalVoxels);
    solidBuffer.fill(0, 0, totalVoxels);
    masksLoBuffer.fill(0, 0, totalBlocks);
    masksHiBuffer.fill(0, 0, totalBlocks);
    const batchMinVoxelX = batchBlockX * 4;
    const batchMinVoxelY = batchBlockY * 4;
    const batchMinVoxelZ = batchBlockZ * 4;
    const batchMaxVoxelX = batchMinVoxelX + numVoxelsX - 1;
    const batchMaxVoxelY = batchMinVoxelY + numVoxelsY - 1;
    const batchMaxVoxelZ = batchMinVoxelZ + numVoxelsZ - 1;
    for (let c = 0; c < indexCount; c++) {
      const i = candidates[indexOffset + c];
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      const opacity = a[i];
      if (opacity <= 0) continue;
      const maxContributionD2 = alphaThreshold <= 0 ? Infinity : (opacity <= alphaThreshold ? 0 : -2 * Math.log(alphaThreshold / opacity));
      if (maxContributionD2 <= 0) continue;
      const ex = ext[i * 3];
      const ey = ext[i * 3 + 1];
      const ez = ext[i * 3 + 2];
      const minIx = Math.max(batchMinVoxelX, Math.floor((xi - ex - gridMinX) / voxelResolution));
      const minIy = Math.max(batchMinVoxelY, Math.floor((yi - ey - gridMinY) / voxelResolution));
      const minIz = Math.max(batchMinVoxelZ, Math.floor((zi - ez - gridMinZ) / voxelResolution));
      const maxIx = Math.min(batchMaxVoxelX, Math.ceil((xi + ex - gridMinX) / voxelResolution));
      const maxIy = Math.min(batchMaxVoxelY, Math.ceil((yi + ey - gridMinY) / voxelResolution));
      const maxIz = Math.min(batchMaxVoxelZ, Math.ceil((zi + ez - gridMinZ) / voxelResolution));
      if (minIx > maxIx || minIy > maxIy || minIz > maxIz) continue;
      const iqx = -qx[i], iqy = -qy[i], iqz = -qz[i], iqw = qw[i];
      const isx = sx[i] > 1e-8 ? 1 / sx[i] : 1e8;
      const isy = sy[i] > 1e-8 ? 1 / sy[i] : 1e8;
      const isz = sz[i] > 1e-8 ? 1 / sz[i] : 1e8;
      for (let iz = minIz; iz <= maxIz; iz++) {
        const localZ = iz - batchMinVoxelZ;
        const vz = gridMinZ + (iz + 0.5) * voxelResolution;
        for (let iy = minIy; iy <= maxIy; iy++) {
          const localY = iy - batchMinVoxelY;
          const vy = gridMinY + (iy + 0.5) * voxelResolution;
          for (let ix = minIx; ix <= maxIx; ix++) {
            const localX = ix - batchMinVoxelX;
            const localIndex = localX + localY * numVoxelsX + localZ * numVoxelsX * numVoxelsY;
            if (solidBuffer[localIndex]) continue;
            const vx = gridMinX + (ix + 0.5) * voxelResolution;
            const px = Math.min(Math.max(xi, vx - half), vx + half);
            const py = Math.min(Math.max(yi, vy - half), vy + half);
            const pz = Math.min(Math.max(zi, vz - half), vz + half);
            const dx = px - xi;
            const dy = py - yi;
            const dz = pz - zi;
            const tx = 2 * (iqy * dz - iqz * dy);
            const ty = 2 * (iqz * dx - iqx * dz);
            const tz = 2 * (iqx * dy - iqy * dx);
            const lx = dx + iqw * tx + (iqy * tz - iqz * ty);
            const ly = dy + iqw * ty + (iqz * tx - iqx * tz);
            const lz = dz + iqw * tz + (iqx * ty - iqy * tx);
            const sxv = lx * isx;
            const syv = ly * isy;
            const szv = lz * isz;
            const d2 = sxv * sxv + syv * syv + szv * szv;
            if (d2 > maxContributionD2) continue;
            const contribution = opacity * Math.exp(-0.5 * d2);
            if (contribution <= 0) continue;
            const total = sigmaBuffer[localIndex] + contribution;
            sigmaBuffer[localIndex] = total;
            if (total < sigmaCutoff) continue;
            solidBuffer[localIndex] = 1;
            const localBlockX = localX >> 2;
            const localBlockY = localY >> 2;
            const localBlockZ = localZ >> 2;
            const localBlock = localBlockX + localBlockY * numBlocksX + localBlockZ * numBlocksX * numBlocksY;
            const bitIdx = (localX & 3) + ((localY & 3) << 2) + ((localZ & 3) << 4);
            if (bitIdx < 32) masksLoBuffer[localBlock] = (masksLoBuffer[localBlock] | (1 << bitIdx)) >>> 0;
            else masksHiBuffer[localBlock] = (masksHiBuffer[localBlock] | (1 << (bitIdx - 32))) >>> 0;
          }
        }
      }
    }
    for (let localBlock = 0; localBlock < totalBlocks; localBlock++) {
      const lo = masksLoBuffer[localBlock];
      const hi = masksHiBuffer[localBlock];
      if ((lo | hi) === 0) continue;
      const localBlockX = localBlock % numBlocksX;
      const localBlockY = ((localBlock / numBlocksX) | 0) % numBlocksY;
      const localBlockZ = (localBlock / (numBlocksX * numBlocksY)) | 0;
      const blockIdx = (batchBlockX + localBlockX) + (batchBlockY + localBlockY) * nBlockX + (batchBlockZ + localBlockZ) * nBlockXY;
      packedBlocks.push(blockIdx >>> 0, lo >>> 0, hi >>> 0);
    }
  }
  const packed = new Uint32Array(packedBlocks.length);
  packed.set(packedBlocks);
  return packed.buffer;
};
parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    process.exit(0);
    return;
  }
  if (msg.type !== 'run') return;
  const taskId = msg.taskId;
  const packed = runBatchSet(msg.batchSpecs, msg.candidateIndices);
  parentPort.postMessage({ taskId, packed }, [packed]);
});
`;
const toSharedFloat32 = (src) => {
    const sab = new SharedArrayBuffer(src.byteLength);
    new Float32Array(sab).set(src);
    return sab;
};
const cpuVoxelizeSingleThread = (xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff) => {
    const nx = Math.max(4, Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution));
    const ny = Math.max(4, Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution));
    const nz = Math.max(4, Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution));
    const gridMinX = gridBounds.min.x;
    const gridMinY = gridBounds.min.y;
    const gridMinZ = gridBounds.min.z;
    const cullMinX = gridBounds.min.x;
    const cullMinY = gridBounds.min.y;
    const cullMinZ = gridBounds.min.z;
    const cullMaxX = gridBounds.max.x;
    const cullMaxY = gridBounds.max.y;
    const cullMaxZ = gridBounds.max.z;
    const half = voxelResolution * 0.5;
    const nBlockX = (nx + 3) >> 2;
    const nBlockY = (ny + 3) >> 2;
    const nBlockXY = nBlockX * nBlockY;
    const opacityThreshold = Math.min(Math.max(opacityCutoff, 0), 1);
    const blockMasks = {};
    for (let i = 0; i < xCol.length; i++) {
        const xi = xCol[i];
        const yi = yCol[i];
        const zi = zCol[i];
        const opacity = aCol[i];
        if (opacity <= 0) {
            continue;
        }
        if (xi < cullMinX || xi > cullMaxX ||
            yi < cullMinY || yi > cullMaxY ||
            zi < cullMinZ || zi > cullMaxZ) {
            continue;
        }
        const maxD2 = opacityThreshold <= 0 ? Infinity : (opacity <= opacityThreshold ? 0 : -2 * Math.log(opacityThreshold / opacity));
        if (maxD2 <= 0) {
            continue;
        }
        const ex = extents[i * 3];
        const ey = extents[i * 3 + 1];
        const ez = extents[i * 3 + 2];
        const minIx = Math.max(0, Math.floor((xi - ex - gridMinX) / voxelResolution));
        const minIy = Math.max(0, Math.floor((yi - ey - gridMinY) / voxelResolution));
        const minIz = Math.max(0, Math.floor((zi - ez - gridMinZ) / voxelResolution));
        const maxIx = Math.min(nx - 1, Math.ceil((xi + ex - gridMinX) / voxelResolution));
        const maxIy = Math.min(ny - 1, Math.ceil((yi + ey - gridMinY) / voxelResolution));
        const maxIz = Math.min(nz - 1, Math.ceil((zi + ez - gridMinZ) / voxelResolution));
        if (minIx > maxIx || minIy > maxIy || minIz > maxIz) {
            continue;
        }
        const qx = qxCol[i];
        const qy = qyCol[i];
        const qz = qzCol[i];
        const qw = qwCol[i];
        // Input quaternions are already normalized.
        const iqx = -qx;
        const iqy = -qy;
        const iqz = -qz;
        const iqw = qw;
        const isx = sxCol[i] > 1e-8 ? 1 / sxCol[i] : 1e8;
        const isy = syCol[i] > 1e-8 ? 1 / syCol[i] : 1e8;
        const isz = szCol[i] > 1e-8 ? 1 / szCol[i] : 1e8;
        for (let iz = minIz; iz <= maxIz; iz++) {
            const vz = gridMinZ + (iz + 0.5) * voxelResolution;
            for (let iy = minIy; iy <= maxIy; iy++) {
                const vy = gridMinY + (iy + 0.5) * voxelResolution;
                for (let ix = minIx; ix <= maxIx; ix++) {
                    const vx = gridMinX + (ix + 0.5) * voxelResolution;
                    const px = Math.min(Math.max(xi, vx - half), vx + half);
                    const py = Math.min(Math.max(yi, vy - half), vy + half);
                    const pz = Math.min(Math.max(zi, vz - half), vz + half);
                    const dx = px - xi;
                    const dy = py - yi;
                    const dz = pz - zi;
                    const tx = 2 * (iqy * dz - iqz * dy);
                    const ty = 2 * (iqz * dx - iqx * dz);
                    const tz = 2 * (iqx * dy - iqy * dx);
                    const lx = dx + iqw * tx + (iqy * tz - iqz * ty);
                    const ly = dy + iqw * ty + (iqz * tx - iqx * tz);
                    const lz = dz + iqw * tz + (iqx * ty - iqy * tx);
                    const sxv = lx * isx;
                    const syv = ly * isy;
                    const szv = lz * isz;
                    const d2 = sxv * sxv + syv * syv + szv * szv;
                    if (d2 > maxD2) {
                        continue;
                    }
                    const blockX = ix >> 2;
                    const blockY = iy >> 2;
                    const blockZ = iz >> 2;
                    const blockLinear = blockX + blockY * nBlockX + blockZ * nBlockXY;
                    const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
                    const curr = blockMasks[blockLinear] ?? [0, 0];
                    if (bitIdx < 32) {
                        curr[0] = (curr[0] | (1 << bitIdx)) >>> 0;
                    }
                    else {
                        curr[1] = (curr[1] | (1 << (bitIdx - 32))) >>> 0;
                    }
                    blockMasks[blockLinear] = curr;
                }
            }
        }
    }
    const output = new BlockMaskBuffer();
    for (const [blockLinearRaw, [lo, hi]] of Object.entries(blockMasks)) {
        const blockLinear = Number(blockLinearRaw);
        output.addBlock(blockLinear, lo, hi);
    }
    return output;
};
export const cpuVoxelize = async (xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff, options) => {
    if (xCol.length < CPU_VOXEL_PARALLEL_MIN_GAUSSIANS) {
        return cpuVoxelizeSingleThread(xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff);
    }
    const nx = Math.max(4, Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution));
    const ny = Math.max(4, Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution));
    const nz = Math.max(4, Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution));
    const gridMinX = gridBounds.min.x;
    const gridMinY = gridBounds.min.y;
    const gridMinZ = gridBounds.min.z;
    if (xCol.length === 0) {
        return new BlockMaskBuffer();
    }
    const workers = Math.min(resolveCpuVoxelWorkerCount(options?.workerCount), xCol.length);
    const nBlockX = (nx + 3) >> 2;
    const nBlockY = (ny + 3) >> 2;
    const nBlockXY = nBlockX * nBlockY;
    const batchBlockSize = 4;
    const numBatchX = Math.ceil(nBlockX / batchBlockSize);
    const numBatchY = Math.ceil(nBlockY / batchBlockSize);
    const numBatchZ = Math.ceil(Math.max(1, (nz + 3) >> 2) / batchBlockSize);
    const bvh = new GaussianBVH(xCol, yCol, zCol, extents);
    const shared = {
        xCol: toSharedFloat32(xCol),
        yCol: toSharedFloat32(yCol),
        zCol: toSharedFloat32(zCol),
        sxCol: toSharedFloat32(sxCol),
        syCol: toSharedFloat32(syCol),
        szCol: toSharedFloat32(szCol),
        qxCol: toSharedFloat32(qxCol),
        qyCol: toSharedFloat32(qyCol),
        qzCol: toSharedFloat32(qzCol),
        qwCol: toSharedFloat32(qwCol),
        aCol: toSharedFloat32(aCol),
        extents: toSharedFloat32(extents)
    };
    try {
        const output = new BlockMaskBuffer();
        let nextTaskId = 1;
        const pool = Array.from({ length: workers }, (_v, slotId) => {
            const worker = new Worker(cpuVoxelizeWorkerScript, {
                eval: true,
                workerData: {
                    workerId: slotId,
                    voxelResolution,
                    opacityCutoff,
                    alphaThreshold: ALPHA_THRESHOLD,
                    gridMinX,
                    gridMinY,
                    gridMinZ,
                    nBlockX,
                    nBlockY,
                    nBlockXY,
                    ...shared
                }
            });
            let currentResolve;
            let currentReject;
            worker.on('message', (message) => {
                if (message && typeof message === 'object' && 'packed' in message) {
                    const typed = message;
                    if (!currentResolve) {
                        return;
                    }
                    const resolve = currentResolve;
                    currentResolve = undefined;
                    currentReject = undefined;
                    resolve({ packed: typed.packed });
                    return;
                }
                if (!currentResolve) {
                    return;
                }
                const resolve = currentResolve;
                currentResolve = undefined;
                currentReject = undefined;
                resolve({ packed: message });
            });
            worker.on('error', (error) => {
                currentReject?.(error);
                currentResolve = undefined;
                currentReject = undefined;
            });
            worker.on('exit', (code) => {
                if (code !== 0) {
                    currentReject?.(new Error(`cpu voxel worker exited with code ${code}`));
                    currentResolve = undefined;
                    currentReject = undefined;
                }
            });
            const runTask = (batchSpecs, candidateIndices) => new Promise((resolve, reject) => {
                if (currentResolve) {
                    reject(new Error(`cpu voxel worker ${slotId} received concurrent task`));
                    return;
                }
                currentResolve = resolve;
                currentReject = reject;
                const taskId = nextTaskId++;
                const batchSpecsBuffer = batchSpecs.buffer;
                const candidateIndicesBuffer = candidateIndices.buffer;
                worker.postMessage({
                    type: 'run',
                    taskId,
                    workerId: slotId,
                    batchSpecs: batchSpecsBuffer,
                    candidateIndices: candidateIndicesBuffer
                }, [batchSpecsBuffer, candidateIndicesBuffer]);
            });
            return { worker, runTask };
        });
        const addPackedResult = (buf) => {
            const packed = new Uint32Array(buf);
            for (let i = 0; i < packed.length; i += 3) {
                output.addBlock(packed[i], packed[i + 1], packed[i + 2]);
            }
        };
        const availableSlots = pool.map((_slot, slotId) => Promise.resolve(slotId));
        const dispatchTask = async (batchSpecs, candidateIndices) => {
            const slotId = await Promise.race(availableSlots);
            availableSlots[slotId] = pool[slotId].runTask(batchSpecs, candidateIndices).then((result) => {
                addPackedResult(result.packed);
                return slotId;
            });
        };
        const maxPendingBatches = 256;
        const maxPendingIndices = 2 * 1024 * 1024;
        const totalBlockZ = Math.max(1, (nz + 3) >> 2);
        let pendingSpecs = [];
        let pendingCandidates = new Uint32Array(Math.min(Math.max(1024, xCol.length), maxPendingIndices));
        let pendingCandidateCount = 0;
        const ensurePendingCandidateCapacity = (needed) => {
            if (needed <= pendingCandidates.length) {
                return;
            }
            const next = new Uint32Array(Math.max(needed, pendingCandidates.length * 2));
            next.set(pendingCandidates.subarray(0, pendingCandidateCount));
            pendingCandidates = next;
        };
        const flushPendingTask = async () => {
            if (pendingSpecs.length === 0) {
                return;
            }
            const batchSpecs = new Uint32Array(pendingSpecs);
            const candidateIndices = pendingCandidates.slice(0, pendingCandidateCount);
            pendingSpecs = [];
            pendingCandidateCount = 0;
            await dispatchTask(batchSpecs, candidateIndices);
        };
        for (let bz = 0; bz < numBatchZ; bz++) {
            for (let by = 0; by < numBatchY; by++) {
                for (let bx = 0; bx < numBatchX; bx++) {
                    const blockX = bx * batchBlockSize;
                    const blockY = by * batchBlockSize;
                    const blockZ = bz * batchBlockSize;
                    const numBlocksX = Math.min(batchBlockSize, nBlockX - blockX);
                    const numBlocksY = Math.min(batchBlockSize, nBlockY - blockY);
                    const numBlocksZ = Math.min(batchBlockSize, totalBlockZ - blockZ);
                    if (numBlocksX <= 0 || numBlocksY <= 0 || numBlocksZ <= 0) {
                        continue;
                    }
                    const minX = gridMinX + blockX * LEAF_SIZE * voxelResolution;
                    const minY = gridMinY + blockY * LEAF_SIZE * voxelResolution;
                    const minZ = gridMinZ + blockZ * LEAF_SIZE * voxelResolution;
                    const maxX = Math.min(gridBounds.max.x, minX + numBlocksX * LEAF_SIZE * voxelResolution);
                    const maxY = Math.min(gridBounds.max.y, minY + numBlocksY * LEAF_SIZE * voxelResolution);
                    const maxZ = Math.min(gridBounds.max.z, minZ + numBlocksZ * LEAF_SIZE * voxelResolution);
                    let overlappingCount = bvh.queryOverlappingRawInto(minX, minY, minZ, maxX, maxY, maxZ, pendingCandidates, pendingCandidateCount);
                    if (overlappingCount === 0) {
                        continue;
                    }
                    if (pendingSpecs.length > 0 &&
                        (pendingSpecs.length / 8 >= maxPendingBatches ||
                            pendingCandidateCount + overlappingCount > maxPendingIndices)) {
                        await flushPendingTask();
                        overlappingCount = bvh.queryOverlappingRawInto(minX, minY, minZ, maxX, maxY, maxZ, pendingCandidates, pendingCandidateCount);
                    }
                    const needed = pendingCandidateCount + overlappingCount;
                    if (needed > pendingCandidates.length) {
                        ensurePendingCandidateCapacity(needed);
                        overlappingCount = bvh.queryOverlappingRawInto(minX, minY, minZ, maxX, maxY, maxZ, pendingCandidates, pendingCandidateCount);
                    }
                    pendingSpecs.push(blockX, blockY, blockZ, numBlocksX, numBlocksY, numBlocksZ, pendingCandidateCount, overlappingCount);
                    pendingCandidateCount += overlappingCount;
                    if (pendingSpecs.length / 8 >= maxPendingBatches || pendingCandidateCount >= maxPendingIndices) {
                        await flushPendingTask();
                    }
                }
            }
        }
        await flushPendingTask();
        await Promise.all(availableSlots);
        await Promise.all(pool.map(async (slot) => {
            slot.worker.postMessage({ type: 'shutdown' });
            await slot.worker.terminate();
        }));
        return output;
    }
    catch (_e) {
        // Fallback when worker threads are unavailable or fail.
        return cpuVoxelizeSingleThread(xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff);
    }
};
/**
 * GPU voxelization path using tiled multi-batch WGSL dispatch.
 * Per-batch Gaussian indices are built on the GPU (count pass, CPU prefix sum, fill pass) into `indexBuffer`,
 * replacing BVH `queryOverlappingRaw` on reference implementation. Batches are packed into mega-dispatches, then read back
 * as per-block 64-bit masks to populate `BlockMaskBuffer`.
 */
export const gpuVoxelize = async (xCol, yCol, zCol, sxCol, syCol, szCol, qxCol, qyCol, qzCol, qwCol, aCol, extents, gridBounds, voxelResolution, opacityCutoff) => {
    const FLOATS_PER_GAUSSIAN = 16;
    const UPLOAD_CHUNK_GAUSSIANS = 1 << 18;
    const WORKGROUP_SIZE = 256;
    // Tuning knobs: trade off submit overhead vs. peak memory/latency per mega-dispatch.
    // Upstream caps 16^3-block batches at 256; with this port's 4^3-block
    // batches, 16384 preserves the same max blocks per mega-dispatch.
    const MEGA_MAX_BATCHES = 16384;
    const MEGA_MAX_INDICES = 2 * 1024 * 1024;
    const BATCH_SIZE = 4;
    const MAX_BLOCKS_PER_BATCH = BATCH_SIZE * BATCH_SIZE * BATCH_SIZE;
    const blockSize = LEAF_SIZE * voxelResolution;
    const numBlocksX = Math.round((gridBounds.max.x - gridBounds.min.x) / blockSize);
    const numBlocksY = Math.round((gridBounds.max.y - gridBounds.min.y) / blockSize);
    const numBlocksZ = Math.round((gridBounds.max.z - gridBounds.min.z) / blockSize);
    const numBatchX = Math.ceil(numBlocksX / BATCH_SIZE);
    const numBatchY = Math.ceil(numBlocksY / BATCH_SIZE);
    const numBatchZ = Math.ceil(numBlocksZ / BATCH_SIZE);
    const totalBatchCount = numBatchX * numBatchY * numBatchZ;
    const gridMinX = gridBounds.min.x;
    const gridMinY = gridBounds.min.y;
    const gridMinZ = gridBounds.min.z;
    const gaussianCount = xCol.length;
    const batchWorldSize = blockSize * BATCH_SIZE;
    const device = await getOrCreateDevice();
    const gaussianBufferBytes = gaussianCount * FLOATS_PER_GAUSSIAN * 4;
    const maxBufferSize = Number(device.limits.maxBufferSize);
    if (gaussianBufferBytes > maxBufferSize) {
        throw new Error(`gpuVoxelize: gaussian buffer size ${gaussianBufferBytes} exceeds device maxBufferSize ${maxBufferSize} ` +
            `(gaussianCount=${gaussianCount}, bytesPerGaussian=${FLOATS_PER_GAUSSIAN * 4}).`);
    }
    const batchCountPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: buildPerBatchCountsWgsl() }), entryPoint: 'main' }
    });
    const batchFillPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: fillPerBatchCandidatesWgsl() }), entryPoint: 'main' }
    });
    const voxelPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: voxelizeMultiBatchWgsl() }), entryPoint: 'main' }
    });
    const blockBuffer = new BlockMaskBuffer();
    const gaussianBuffer = device.createBuffer({
        size: gaussianBufferBytes,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
    });
    const chunkRows = Math.min(gaussianCount, UPLOAD_CHUNK_GAUSSIANS);
    const interleavedChunk = new Float32Array(chunkRows * FLOATS_PER_GAUSSIAN);
    for (let chunkStart = 0; chunkStart < gaussianCount; chunkStart += chunkRows) {
        const chunkCount = Math.min(chunkRows, gaussianCount - chunkStart);
        for (let j = 0; j < chunkCount; j++) {
            const i = chunkStart + j;
            const offset = j * FLOATS_PER_GAUSSIAN;
            interleavedChunk[offset + 0] = xCol[i];
            interleavedChunk[offset + 1] = yCol[i];
            interleavedChunk[offset + 2] = zCol[i];
            interleavedChunk[offset + 3] = aCol[i];
            const rotW = qwCol[i];
            const rotX = qxCol[i];
            const rotY = qyCol[i];
            const rotZ = qzCol[i];
            const qlen = Math.sqrt(rotW * rotW + rotX * rotX + rotY * rotY + rotZ * rotZ);
            const invLen = qlen > 0 ? 1 / qlen : 0;
            interleavedChunk[offset + 4] = rotW * invLen;
            interleavedChunk[offset + 5] = rotX * invLen;
            interleavedChunk[offset + 6] = rotY * invLen;
            interleavedChunk[offset + 7] = rotZ * invLen;
            interleavedChunk[offset + 8] = sxCol[i];
            interleavedChunk[offset + 9] = syCol[i];
            interleavedChunk[offset + 10] = szCol[i];
            interleavedChunk[offset + 11] = extents[i * 3 + 0];
            interleavedChunk[offset + 12] = extents[i * 3 + 1];
            interleavedChunk[offset + 13] = extents[i * 3 + 2];
            interleavedChunk[offset + 14] = 0;
            interleavedChunk[offset + 15] = 0;
        }
        device.queue.writeBuffer(gaussianBuffer, chunkStart * FLOATS_PER_GAUSSIAN * 4, interleavedChunk.buffer, 0, chunkCount * FLOATS_PER_GAUSSIAN * 4);
    }
    const batchUniformBuffer = device.createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST
    });
    const batchCountsBuffer = device.createBuffer({
        size: Math.max(4, totalBatchCount * 4),
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC
    });
    const batchCountsReadBuffer = device.createBuffer({
        size: Math.max(4, totalBatchCount * 4),
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
    });
    const batchUniformRaw = new Uint32Array(16);
    const batchUniformFloats = new Float32Array(batchUniformRaw.buffer);
    batchUniformFloats[0] = gridMinX;
    batchUniformFloats[1] = gridMinY;
    batchUniformFloats[2] = gridMinZ;
    batchUniformFloats[3] = batchWorldSize;
    batchUniformRaw[4] = numBatchX;
    batchUniformRaw[5] = numBatchY;
    batchUniformRaw[6] = numBatchZ;
    batchUniformRaw[7] = gaussianCount;
    device.queue.writeBuffer(batchUniformBuffer, 0, batchUniformRaw.buffer, 0, 32);
    const countBindGroup = device.createBindGroup({
        layout: batchCountPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: batchUniformBuffer } },
            { binding: 1, resource: { buffer: gaussianBuffer } },
            { binding: 2, resource: { buffer: batchCountsBuffer } }
        ]
    });
    const zeroBatchCounts = new Uint32Array(Math.max(1, totalBatchCount));
    device.queue.writeBuffer(batchCountsBuffer, 0, zeroBatchCounts);
    // Count overlaps per coarse batch on GPU; copy out for CPU exclusive-prefix into batchCandidateOffsets.
    {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(batchCountPipeline);
        pass.setBindGroup(0, countBindGroup);
        pass.dispatchWorkgroups(Math.ceil(gaussianCount / WORKGROUP_SIZE), 1, 1);
        pass.end();
        encoder.copyBufferToBuffer(batchCountsBuffer, 0, batchCountsReadBuffer, 0, totalBatchCount * 4);
        device.queue.submit([encoder.finish()]);
    }
    await batchCountsReadBuffer.mapAsync(GPU_MAP_MODE_READ);
    const countsMapped = new Uint32Array(batchCountsReadBuffer.getMappedRange());
    const batchCandidateCounts = new Uint32Array(totalBatchCount);
    batchCandidateCounts.set(countsMapped.subarray(0, totalBatchCount));
    batchCountsReadBuffer.unmap();
    const batchCandidateOffsets = new Uint32Array(totalBatchCount);
    let totalCandidateCount = 0;
    for (let i = 0; i < totalBatchCount; i++) {
        batchCandidateOffsets[i] = totalCandidateCount;
        totalCandidateCount += batchCandidateCounts[i];
    }
    if (totalCandidateCount === 0) {
        batchUniformBuffer.destroy();
        batchCountsBuffer.destroy();
        batchCountsReadBuffer.destroy();
        gaussianBuffer.destroy();
        return blockBuffer;
    }
    const batchOffsetsBuffer = device.createBuffer({
        size: batchCandidateOffsets.byteLength,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
    });
    device.queue.writeBuffer(batchOffsetsBuffer, 0, batchCandidateOffsets);
    const batchWriteHeadsBuffer = device.createBuffer({
        size: Math.max(4, totalBatchCount * 4),
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
    });
    device.queue.writeBuffer(batchWriteHeadsBuffer, 0, zeroBatchCounts);
    // Packed gaussian indices for all batches (size = totalCandidateCount); filled by GPU scatter pass.
    const indexBuffer = device.createBuffer({
        size: totalCandidateCount * 4,
        usage: GPU_BUFFER_USAGE_STORAGE
    });
    // GPU scatter pass: write gaussian indices into each batch segment of `indexBuffer`.
    const fillBindGroup = device.createBindGroup({
        layout: batchFillPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: batchUniformBuffer } },
            { binding: 1, resource: { buffer: gaussianBuffer } },
            { binding: 2, resource: { buffer: batchOffsetsBuffer } },
            { binding: 3, resource: { buffer: batchWriteHeadsBuffer } },
            { binding: 4, resource: { buffer: indexBuffer } }
        ]
    });
    {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(batchFillPipeline);
        pass.setBindGroup(0, fillBindGroup);
        pass.dispatchWorkgroups(Math.ceil(gaussianCount / WORKGROUP_SIZE), 1, 1);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }
    // BatchInfo struct in WGSL: 5xu32 + 3xf32 packed as 8xu32 per batch.
    const BATCH_INFO_U32S = 8;
    const createSlot = () => {
        const uniformBuffer = device.createBuffer({
            size: 256,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST
        });
        const resultsBuffer = device.createBuffer({
            size: MEGA_MAX_BATCHES * MAX_BLOCKS_PER_BATCH * 2 * 4,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST
        });
        const readBuffer = device.createBuffer({
            size: MEGA_MAX_BATCHES * MAX_BLOCKS_PER_BATCH * 2 * 4,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
        });
        const batchInfoBuffer = device.createBuffer({
            size: MEGA_MAX_BATCHES * BATCH_INFO_U32S * 4,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
        });
        const bindGroup = device.createBindGroup({
            layout: voxelPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: { buffer: gaussianBuffer } },
                { binding: 2, resource: { buffer: indexBuffer } },
                { binding: 3, resource: { buffer: resultsBuffer } },
                { binding: 4, resource: { buffer: batchInfoBuffer } }
            ]
        });
        return {
            uniformBuffer,
            resultsBuffer,
            readBuffer,
            batchInfoBuffer,
            bindGroup,
            resultsBufferSize: MEGA_MAX_BATCHES * MAX_BLOCKS_PER_BATCH * 2 * 4,
            batchInfoCapacityBytes: MEGA_MAX_BATCHES * BATCH_INFO_U32S * 4
        };
    };
    const slots = [createSlot(), createSlot()];
    let currentSlot = 0;
    let inflight;
    const ensureSlotCapacity = (slot, batchCount) => {
        const resultBytes = Math.max(8, batchCount * MAX_BLOCKS_PER_BATCH * 2 * 4);
        const batchInfoBytes = Math.max(32, batchCount * BATCH_INFO_U32S * 4);
        if (resultBytes > slot.resultsBufferSize) {
            slot.resultsBuffer.destroy();
            slot.readBuffer.destroy();
            // Growth (at least x2) avoids frequent GPU buffer reallocations when batch sizes fluctuate.
            slot.resultsBufferSize = Math.max(slot.resultsBufferSize * 2, resultBytes);
            slot.resultsBuffer = device.createBuffer({
                size: slot.resultsBufferSize,
                usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST
            });
            slot.readBuffer = device.createBuffer({
                size: slot.resultsBufferSize,
                usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
            });
            slot.bindGroup = device.createBindGroup({
                layout: voxelPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: slot.uniformBuffer } },
                    { binding: 1, resource: { buffer: gaussianBuffer } },
                    { binding: 2, resource: { buffer: indexBuffer } },
                    { binding: 3, resource: { buffer: slot.resultsBuffer } },
                    { binding: 4, resource: { buffer: slot.batchInfoBuffer } }
                ]
            });
        }
        if (batchInfoBytes > slot.batchInfoCapacityBytes) {
            slot.batchInfoBuffer.destroy();
            // Same growth policy as results/read buffers.
            slot.batchInfoCapacityBytes = Math.max(slot.batchInfoCapacityBytes * 2, batchInfoBytes);
            slot.batchInfoBuffer = device.createBuffer({
                size: slot.batchInfoCapacityBytes,
                usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
            });
            slot.bindGroup = device.createBindGroup({
                layout: voxelPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: slot.uniformBuffer } },
                    { binding: 1, resource: { buffer: gaussianBuffer } },
                    { binding: 2, resource: { buffer: indexBuffer } },
                    { binding: 3, resource: { buffer: slot.resultsBuffer } },
                    { binding: 4, resource: { buffer: slot.batchInfoBuffer } }
                ]
            });
        }
    };
    const processResults = (masks, batches) => {
        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            const batchResultOffset = b * MAX_BLOCKS_PER_BATCH * 2;
            const totalBatchBlocks = batch.numBlocksX * batch.numBlocksY * batch.numBlocksZ;
            for (let blockIdx = 0; blockIdx < totalBatchBlocks; blockIdx++) {
                const maskLo = masks[batchResultOffset + blockIdx * 2];
                const maskHi = masks[batchResultOffset + blockIdx * 2 + 1];
                if (maskLo === 0 && maskHi === 0) {
                    continue;
                }
                const localX = blockIdx % batch.numBlocksX;
                const localY = Math.floor(blockIdx / batch.numBlocksX) % batch.numBlocksY;
                const localZ = Math.floor(blockIdx / (batch.numBlocksX * batch.numBlocksY));
                const blockLinear = (batch.bx + localX) + (batch.by + localY) * numBlocksX + (batch.bz + localZ) * numBlocksX * numBlocksY;
                blockBuffer.addBlock(blockLinear, maskLo, maskHi);
            }
        }
    };
    let pendingBatches = [];
    let megaIndexSpan = 0;
    const flushPendingBatches = async () => {
        if (pendingBatches.length === 0) {
            return;
        }
        const submitSlot = currentSlot;
        currentSlot = (currentSlot + 1) & 1;
        const batchesToSubmit = pendingBatches;
        pendingBatches = [];
        megaIndexSpan = 0;
        const slot = slots[submitSlot];
        ensureSlotCapacity(slot, batchesToSubmit.length);
        const resultsU32Count = batchesToSubmit.length * MAX_BLOCKS_PER_BATCH * 2;
        const batchInfoU32Count = batchesToSubmit.length * BATCH_INFO_U32S;
        const batchInfoF32 = new Float32Array(batchInfoU32Count);
        const batchInfoU32 = new Uint32Array(batchInfoF32.buffer);
        for (let i = 0; i < batchesToSubmit.length; i++) {
            const batch = batchesToSubmit[i];
            const base = i * BATCH_INFO_U32S;
            batchInfoU32[base + 0] = batch.indexOffset;
            batchInfoU32[base + 1] = batch.indexCount;
            batchInfoU32[base + 2] = batch.numBlocksX;
            batchInfoU32[base + 3] = batch.numBlocksY;
            batchInfoU32[base + 4] = batch.numBlocksZ;
            batchInfoF32[base + 5] = batch.blockMinX;
            batchInfoF32[base + 6] = batch.blockMinY;
            batchInfoF32[base + 7] = batch.blockMinZ;
        }
        device.queue.writeBuffer(slot.batchInfoBuffer, 0, batchInfoU32.buffer, batchInfoU32.byteOffset, batchInfoU32.byteLength);
        const uniform = new Uint32Array(16);
        const uf = new Float32Array(uniform.buffer);
        uf[0] = opacityCutoff;
        uf[1] = voxelResolution;
        uniform[2] = MAX_BLOCKS_PER_BATCH;
        device.queue.writeBuffer(slot.uniformBuffer, 0, uniform.buffer, 0, 12);
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(slot.resultsBuffer, 0, resultsU32Count * 4);
        const pass = encoder.beginComputePass();
        pass.setPipeline(voxelPipeline);
        pass.setBindGroup(0, slot.bindGroup);
        pass.dispatchWorkgroups(MAX_BLOCKS_PER_BATCH, 1, batchesToSubmit.length);
        pass.end();
        encoder.copyBufferToBuffer(slot.resultsBuffer, 0, slot.readBuffer, 0, resultsU32Count * 4);
        device.queue.submit([encoder.finish()]);
        const taskPromise = (async () => {
            await slot.readBuffer.mapAsync(GPU_MAP_MODE_READ);
            const mapped = new Uint32Array(slot.readBuffer.getMappedRange());
            const copied = new Uint32Array(resultsU32Count);
            copied.set(mapped.subarray(0, resultsU32Count));
            slot.readBuffer.unmap();
            return { masks: copied, batches: batchesToSubmit };
        })();
        if (inflight) {
            const done = await inflight.taskId;
            processResults(done.masks, done.batches);
        }
        inflight = { taskId: taskPromise };
    };
    for (let bz = 0; bz < numBatchZ; bz++) {
        for (let by = 0; by < numBatchY; by++) {
            for (let bx = 0; bx < numBatchX; bx++) {
                const batchId = bz * numBatchX * numBatchY + by * numBatchX + bx;
                const indexCount = batchCandidateCounts[batchId];
                if (indexCount === 0) {
                    continue;
                }
                const bxBlock = bx * BATCH_SIZE;
                const byBlock = by * BATCH_SIZE;
                const bzBlock = bz * BATCH_SIZE;
                const currBatchX = Math.min(BATCH_SIZE, numBlocksX - bxBlock);
                const currBatchY = Math.min(BATCH_SIZE, numBlocksY - byBlock);
                const currBatchZ = Math.min(BATCH_SIZE, numBlocksZ - bzBlock);
                // World-space origin of this batch's 16^3 block grid; indexOffset/indexCount refer to `indexBuffer`.
                const blockMinX = gridMinX + bxBlock * blockSize;
                const blockMinY = gridMinY + byBlock * blockSize;
                const blockMinZ = gridMinZ + bzBlock * blockSize;
                pendingBatches.push({
                    indexOffset: batchCandidateOffsets[batchId],
                    indexCount,
                    blockMinX,
                    blockMinY,
                    blockMinZ,
                    numBlocksX: currBatchX,
                    numBlocksY: currBatchY,
                    numBlocksZ: currBatchZ,
                    bx: bxBlock,
                    by: byBlock,
                    bz: bzBlock
                });
                megaIndexSpan += indexCount;
                if (pendingBatches.length >= MEGA_MAX_BATCHES || megaIndexSpan >= MEGA_MAX_INDICES) {
                    await flushPendingBatches();
                }
            }
        }
    }
    await flushPendingBatches();
    if (inflight) {
        const done = await inflight.taskId;
        processResults(done.masks, done.batches);
    }
    batchUniformBuffer.destroy();
    batchCountsBuffer.destroy();
    batchCountsReadBuffer.destroy();
    batchOffsetsBuffer.destroy();
    batchWriteHeadsBuffer.destroy();
    indexBuffer.destroy();
    for (const slot of slots) {
        slot.uniformBuffer.destroy();
        slot.resultsBuffer.destroy();
        slot.readBuffer.destroy();
        slot.batchInfoBuffer.destroy();
    }
    gaussianBuffer.destroy();
    return blockBuffer;
};
