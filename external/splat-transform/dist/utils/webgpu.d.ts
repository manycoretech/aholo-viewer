export declare function enumerateAdapters(): Promise<{
    index: number;
    name: string;
}[]>;
export declare function initGPUAdapter(options?: string[]): void;
export declare function createDevice(): Promise<GPUDevice>;
declare const getOrCreateDevice: () => Promise<GPUDevice>, releaseSharedDevice: () => void;
export { getOrCreateDevice, releaseSharedDevice };
