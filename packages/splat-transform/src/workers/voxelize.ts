import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
    throw new Error('worker must run inside worker_threads');
}

const {
    voxelResolution,
    opacityCutoff,
    alphaThreshold,
    gridMinX,
    gridMinY,
    gridMinZ,
    nBlockX,
    // nBlockY,
    nBlockXY,
    xCol,
    yCol,
    zCol,
    sxCol,
    syCol,
    szCol,
    qxCol,
    qyCol,
    qzCol,
    qwCol,
    aCol,
    extents,
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

function runBatchSet(batchSpecs: any, candidateIndices: any) {
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
            const maxContributionD2 =
                alphaThreshold <= 0
                    ? Infinity
                    : opacity <= alphaThreshold
                      ? 0
                      : -2 * Math.log(alphaThreshold / opacity);
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
            const iqx = -qx[i],
                iqy = -qy[i],
                iqz = -qz[i],
                iqw = qw[i];
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
                        const localBlock =
                            localBlockX + localBlockY * numBlocksX + localBlockZ * numBlocksX * numBlocksY;
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
            const blockIdx =
                batchBlockX +
                localBlockX +
                (batchBlockY + localBlockY) * nBlockX +
                (batchBlockZ + localBlockZ) * nBlockXY;
            packedBlocks.push(blockIdx >>> 0, lo >>> 0, hi >>> 0);
        }
    }
    const packed = new Uint32Array(packedBlocks.length);
    packed.set(packedBlocks);
    return packed.buffer;
}

parentPort.on('message', msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'shutdown') {
        process.exit(0);
    }
    if (msg.type !== 'run') return;
    const taskId = msg.taskId;
    const packed = runBatchSet(msg.batchSpecs, msg.candidateIndices);
    parentPort!.postMessage({ taskId, packed }, [packed]);
});
