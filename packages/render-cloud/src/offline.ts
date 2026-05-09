import { RenderCloudClient } from './client';
import type { OfflineRenderResult, Operation, RenderCloudConfig } from './types';
import { sleep } from './utils';

/** Offline render jobs (`POST /rendercloud/v1/jobs`). */
export class OfflineRenderClient {
    readonly #client: RenderCloudClient;

    constructor(config: RenderCloudConfig) {
        this.#client = new RenderCloudClient(config);
    }

    submitJob(usda: string, imgSize: { width: number; height: number }): Promise<Operation<OfflineRenderResult>> {
        return this.#client.submitOfflineJob(usda, { x: imgSize.width, y: imgSize.height });
    }

    pollJob(operationId: string | number): Promise<Operation<OfflineRenderResult>> {
        return this.#client.pollOfflineJob(operationId);
    }

    async waitForJob(
        operationId: string | number,
        options?: { intervalMs?: number; timeoutMs?: number },
    ): Promise<Operation<OfflineRenderResult>> {
        const intervalMs = options?.intervalMs ?? 1000;
        const timeoutMs = options?.timeoutMs ?? 300_000;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
            const operation = await this.pollJob(operationId);
            if (operation.done) {
                return operation;
            }
            await sleep(intervalMs);
        }

        throw new Error('Timed out waiting for offline render job.');
    }
}
