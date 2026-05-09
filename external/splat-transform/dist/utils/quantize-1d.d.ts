export declare function quantize1d(fields: Float32Array[], k?: number, alpha?: number, transform?: (v: number) => number): {
    centroids: Float32Array<ArrayBuffer>;
    labels: Uint8Array<ArrayBuffer>[];
};
