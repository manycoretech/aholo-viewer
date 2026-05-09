export declare function kmeans(points: Float32Array[], k: number, iterations: number, device: GPUDevice): Promise<{
    centroids: Float32Array<ArrayBufferLike>[];
    labels: Uint32Array<ArrayBuffer>;
}>;
