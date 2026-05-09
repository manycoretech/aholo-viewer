import { clusterAverage } from '../native/index.js';
import { logger } from './index.js';
// in the 1d case we use quantile-based initialization for better handling of skewed data
function initializeCentroids1D(data, centroids) {
    const n = data.length;
    const k = centroids.length;
    // Sort data to compute quantiles
    const sorted = Float32Array.from(data).sort((a, b) => a - b);
    for (let i = 0; i < k; ++i) {
        // Place centroid at the center of its expected cluster region
        const quantile = (2 * i + 1) / (2 * k);
        const index = Math.min(Math.floor(quantile * n), n - 1);
        centroids[i] = sorted[index];
    }
}
;
// use floyd's algorithm to pick m unique random indices from 0..n-1
function pickRandomIndices(n, m) {
    const chosen = new Set();
    for (let j = n - m; j < n; j++) {
        const t = Math.floor(Math.random() * (j + 1));
        chosen.add(chosen.has(t) ? j : t);
    }
    return [...chosen];
}
;
function initializeCentroids(dataTable, centroids) {
    const indices = pickRandomIndices(dataTable[0].length, centroids[0].length);
    for (let i = 0; i < centroids[0].length; i++) {
        for (let j = 0; j < dataTable.length; j++) {
            centroids[j][i] = dataTable[j][indices[i]];
        }
    }
}
;
const chunkSize = 128;
const workgroupSize = 64;
function clusterWgsl(numColumns) {
    return /* wgsl */ `
struct Uniforms {
    numPoints: u32,
    numCentroids: u32
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> points: array<f32>;
@group(0) @binding(2) var<storage, read> centroids: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<u32>;

const numColumns = ${numColumns};   // number of columns in the points and centroids tables
const chunkSize = ${chunkSize}u;             // must be a multiple of 64
const workgroupSize = ${workgroupSize}u;
var<workgroup> sharedChunk: array<f32, numColumns * chunkSize>;

// calculate the squared distance between the point and centroid
fn calcDistanceSqr(point: array<f32, numColumns>, centroid: u32) -> f32 {
    var result = 0.0;

    var ci = centroid * numColumns;

    for (var i = 0u; i < numColumns; i++) {
        let v = f32(point[i] - sharedChunk[ci+i]);
        result += v * v;
    }

    return result;
}

@compute @workgroup_size(workgroupSize)
fn main(
    @builtin(local_invocation_index) local_id : u32,
    @builtin(global_invocation_id) global_id: vec3u,
    @builtin(num_workgroups) num_workgroups: vec3u
) {
    // calculate row index for this thread point
    let pointIndex = global_id.x + global_id.y * num_workgroups.x * workgroupSize;

    // copy the point data from global memory
    var point: array<f32, numColumns>;
    if (pointIndex < uniforms.numPoints) {
        for (var i = 0u; i < numColumns; i++) {
            point[i] = points[pointIndex * numColumns + i];
        }
    }

    var mind = 1000000.0;
    var mini = 0u;

    // work through the list of centroids in shared memory chunks
    let numChunks = u32(ceil(f32(uniforms.numCentroids) / f32(chunkSize)));
    for (var i = 0u; i < numChunks; i++) {

        // copy this thread's slice of the centroid shared chunk data
        let dstRow = local_id * (chunkSize / workgroupSize);
        let srcRow = min(uniforms.numCentroids, i * chunkSize + local_id * chunkSize / workgroupSize);
        let numRows = min(uniforms.numCentroids, srcRow + chunkSize / workgroupSize) - srcRow;

        var dst = dstRow * numColumns;
        var src = srcRow * numColumns;

        for (var c = 0u; c < numRows * numColumns; c++) {
            sharedChunk[dst + c] = centroids[src + c];
        }

        // wait for all threads to finish writing their part of centroids shared memory buffer
        workgroupBarrier();

        // loop over the next chunk of centroids finding the closest
        if (pointIndex < uniforms.numPoints) {
            let thisChunkSize = min(chunkSize, uniforms.numCentroids - i * chunkSize);
            for (var c = 0u; c < thisChunkSize; c++) {
                let d = calcDistanceSqr(point, c);
                if (d < mind) {
                    mind = d;
                    mini = i * chunkSize + c;
                }
            }
        }

        // next loop will overwrite the shared memory, so wait
        workgroupBarrier();
    }

    if (pointIndex < uniforms.numPoints) {
        results[pointIndex] = mini;
    }
}
`;
}
function interleaveData(result, dataTable, numRows, rowOffset) {
    const numColumns = dataTable.length;
    for (let c = 0; c < numColumns; ++c) {
        const column = dataTable[c];
        for (let r = 0; r < numRows; ++r) {
            result[r * numColumns + c] = column[rowOffset + r];
        }
    }
}
const MAX_CONCURRENCY_BATCHES = 10;
class GpuClustering {
    device;
    numPoints;
    numColumns;
    numCentroids;
    batchSize;
    resource;
    numBatches;
    concurrencyBatches;
    concurrencyRuns;
    constructor(device, numPoints, numColumns, numCentroids) {
        this.device = device;
        this.numPoints = numPoints;
        this.numColumns = numColumns;
        this.numCentroids = numCentroids;
        const workgroupsPerBatch = Math.min(device.limits.maxComputeWorkgroupsPerDimension, // device dispatch limit
        Math.floor(device.limits.maxBufferSize / (numColumns * workgroupSize * 4)), // point storage limit
        Math.ceil(numPoints / workgroupSize) // max limit
        );
        this.batchSize = workgroupsPerBatch * workgroupSize;
        this.numBatches = Math.ceil(numPoints / this.batchSize);
        this.concurrencyBatches = Math.min(MAX_CONCURRENCY_BATCHES, this.numBatches);
        this.concurrencyRuns = Math.ceil(this.numBatches / this.concurrencyBatches);
        const shader = device.createShaderModule({
            code: clusterWgsl(numColumns),
        });
        const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shader,
                entryPoint: 'main'
            }
        });
        const pointsBackBuffer = new Float32Array(numColumns * this.batchSize);
        const centroidsBackBuffer = new Float32Array(numColumns * numCentroids);
        const uniformBackBuffer = new Uint32Array([0, numCentroids]);
        const pointsBuffers = [];
        const centroidsBuffer = device.createBuffer({
            size: centroidsBackBuffer.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        });
        const uniformBuffer = device.createBuffer({
            size: 256 * this.concurrencyBatches,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
        });
        const resultBuffer = device.createBuffer({
            size: this.concurrencyBatches * this.batchSize * 4,
            usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE
        });
        const resultReadBackBuffer = device.createBuffer({
            size: this.concurrencyBatches * this.batchSize * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const layout = pipeline.getBindGroupLayout(0);
        const bindGroups = [];
        for (let i = 0; i < this.concurrencyBatches; i++) {
            const pointsBuffer = device.createBuffer({
                size: pointsBackBuffer.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            pointsBuffers.push(pointsBuffer);
            bindGroups.push(device.createBindGroup({
                layout,
                entries: [{
                        binding: 0,
                        resource: {
                            buffer: uniformBuffer,
                            offset: i * 256,
                            size: 8
                        }
                    }, {
                        binding: 1,
                        resource: pointsBuffer,
                    }, {
                        binding: 2,
                        resource: centroidsBuffer,
                    }, {
                        binding: 3,
                        resource: {
                            buffer: resultBuffer,
                            offset: i * this.batchSize * 4,
                            size: this.batchSize * 4
                        }
                    }]
            }));
        }
        this.resource = {
            pipeline,
            bindGroups,
            gpuBuffers: {
                uniform: uniformBuffer,
                points: pointsBuffers,
                centroids: centroidsBuffer,
                result: resultBuffer,
                resultReadBack: resultReadBackBuffer,
            },
            backBuffers: {
                uniform: uniformBackBuffer,
                points: pointsBackBuffer,
                centroids: centroidsBackBuffer,
            },
            uploadedBatches: [],
        };
        logger.info(`GPU k-means kernel bootstrapped with batch ${workgroupsPerBatch}*${workgroupSize}*${this.numBatches}, concurrency: ${this.concurrencyBatches}, runs: ${this.concurrencyRuns}`);
    }
    async execute(points, centroids, labels) {
        const { device, numPoints, numColumns, numCentroids, numBatches, batchSize, resource, concurrencyBatches, concurrencyRuns } = this;
        // upload centroid data to gpu
        interleaveData(resource.backBuffers.centroids, centroids, numCentroids, 0);
        device.queue.writeBuffer(resource.gpuBuffers.centroids, 0, resource.backBuffers.centroids.buffer);
        for (let i = 0; i < concurrencyRuns; i++) {
            const batchStart = i * concurrencyBatches;
            let resultCount = 0;
            for (let j = 0; j < concurrencyBatches; j++) {
                const batchIndex = batchStart + j;
                if (batchIndex >= numBatches) {
                    break;
                }
                const currentBatchSize = Math.min(numPoints - batchIndex * batchSize, batchSize);
                resultCount += currentBatchSize;
                // write this batch of point data to gpu
                if (resource.uploadedBatches[j] !== batchIndex) {
                    interleaveData(resource.backBuffers.points, points, currentBatchSize, batchIndex * batchSize);
                    device.queue.writeBuffer(resource.gpuBuffers.points[j], 0, resource.backBuffers.points.buffer, 0, numColumns * currentBatchSize * 4);
                    resource.backBuffers.uniform[0] = currentBatchSize;
                    device.queue.writeBuffer(resource.gpuBuffers.uniform, 256 * j, resource.backBuffers.uniform.buffer, 0, 8);
                    resource.uploadedBatches[j] = batchIndex;
                }
            }
            const encoder = device.createCommandEncoder();
            const computePass = encoder.beginComputePass();
            computePass.setPipeline(resource.pipeline);
            for (let j = 0; j < concurrencyBatches; j++) {
                const batchIndex = batchStart + j;
                if (batchIndex >= numBatches) {
                    break;
                }
                const currentBatchSize = Math.min(numPoints - batchIndex * batchSize, batchSize);
                const groups = Math.ceil(currentBatchSize / workgroupSize);
                computePass.setBindGroup(0, resource.bindGroups[j]);
                computePass.dispatchWorkgroups(groups);
            }
            computePass.end();
            encoder.copyBufferToBuffer(resource.gpuBuffers.result, 0, resource.gpuBuffers.resultReadBack, 0, resultCount * 4);
            device.queue.submit([encoder.finish()]);
            await resource.gpuBuffers.resultReadBack.mapAsync(GPUMapMode.READ);
            const mapped = resource.gpuBuffers.resultReadBack.getMappedRange();
            labels.set(new Uint32Array(mapped, 0, resultCount), batchStart * batchSize);
            resource.gpuBuffers.resultReadBack.unmap();
        }
        ;
    }
    destroy() {
        this.resource.gpuBuffers.uniform.destroy();
        this.resource.gpuBuffers.centroids.destroy();
        this.resource.gpuBuffers.result.destroy();
        this.resource.gpuBuffers.resultReadBack.destroy();
        for (const buffer of this.resource.gpuBuffers.points) {
            buffer.destroy();
        }
    }
}
function groupLabels(labels, k) {
    const clusters = [];
    for (let i = 0; i < k; ++i) {
        clusters[i] = [];
    }
    for (let i = 0; i < labels.length; ++i) {
        clusters[labels[i]].push(i);
    }
    return clusters.map(c => new Uint32Array(c));
}
;
// https://github.com/playcanvas/splat-transform/blob/main/src/lib/spatial/k-means.ts
export async function kmeans(points, k, iterations, device) {
    const numRows = points.length > 0 ? points[0].length : 0;
    if (numRows < k) {
        return {
            centroids: points,
            // use a typed array here so downstream code can rely on
            // labels supporting subarray(), even in this early-return
            // path used for very small datasets.
            labels: new Uint32Array(numRows).map((_, i) => i)
        };
    }
    const centroids = points.map(_ => new Float32Array(k));
    if (points.length === 1) {
        initializeCentroids1D(points[0], centroids[0]);
    }
    else {
        initializeCentroids(points, centroids);
    }
    const gpuClustering = new GpuClustering(device, numRows, points.length, k);
    const labels = new Uint32Array(numRows);
    let converged = false;
    let steps = 0;
    while (!converged) {
        logger.info(`kmeans iteration ${steps + 1}`);
        await gpuClustering.execute(points, centroids, labels);
        clusterAverage(points, groupLabels(labels, k), centroids);
        steps++;
        if (steps >= iterations) {
            converged = true;
        }
    }
    gpuClustering.destroy();
    return {
        centroids,
        labels
    };
}
