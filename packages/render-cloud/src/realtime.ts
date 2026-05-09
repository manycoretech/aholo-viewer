import { RenderCloudClient } from './client';
import { buildStreamingWebSocketUrl, StreamingConnection } from './streaming';
import type {
    RealtimeSessionOptions,
    RealtimeStreamResult,
    RenderCloudConfig,
    RenderFrame,
    SessionState,
} from './types';
import type { UsdCameraParams } from './types';
import { patchUsdCamera } from './usd';
import { RENDER_CLOUD_DEFAULT_MAX_PATCHES_PER_MINUTE, RENDER_CLOUD_DEFAULT_PATCH_THROTTLE_MS } from './constants';
import { PatchRateLimiter, RenderCloudError, readGatewayErrorMessage, sleep } from './utils';

export interface RealtimeSession {
    readonly sessionId: string;
    readonly state: SessionState;
    ready(): Promise<void>;
    /**
     * Replace the session scene and push the full OpenUSD ASCII (throttled).
     * Use when the scene graph or payloads change.
     */
    push(usda: string): void;
    /**
     * Patch `MainCamera` / `MainRenderSettings` on the session's current USDA and push (throttled).
     * Smaller than {@link push} when only the view changes.
     */
    pushCamera(
        camera: UsdCameraParams,
        options?: {
            cameraPrimName?: string;
            renderSettingsPrimName?: string;
        },
    ): void;
    onFrame(handler: (frame: RenderFrame) => void): () => void;
    onError(handler: (error: unknown) => void): () => void;
    onStateChange(handler: (state: SessionState) => void): () => void;
    close(): Promise<void>;
}

type Handler<T> = (value: T) => void;

/**
 * Create a realtime session: REST submit poll ACTIVE WebSocket optional `:push` updates.
 * Aligns with OpenAPI `openapi.yaml` (RenderCloud tag).
 */
export async function createRealtimeSession(
    config: RenderCloudConfig,
    options: RealtimeSessionOptions,
): Promise<RealtimeSession> {
    const client = new RenderCloudClient(config);
    const resolved = client.resolved;
    const pollInterval = options.poll?.intervalMs ?? 2000;
    const pollTimeout = options.poll?.timeoutMs ?? 120_000;
    const patchThrottleMs = options.patchThrottleMs ?? RENDER_CLOUD_DEFAULT_PATCH_THROTTLE_MS;
    const rateLimiter = new PatchRateLimiter(
        options.maxPatchesPerMinute ?? RENDER_CLOUD_DEFAULT_MAX_PATCHES_PER_MINUTE,
    );
    const waitForFirstFrame = options.waitForFirstFrame ?? false;

    let usda = options.usda;
    let sessionId = '';
    let state: SessionState = 'creating';
    let streaming: StreamingConnection | undefined;
    let closed = false;
    let serverCloseStarted = false;
    let readyPromise: Promise<void> | undefined;
    let patchTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingPatch = false;
    let lastPatchAt = 0;

    const frameHandlers = new Set<Handler<RenderFrame>>();
    const errorHandlers = new Set<Handler<unknown>>();
    const stateHandlers = new Set<Handler<SessionState>>();

    if (options.onFrame) {
        frameHandlers.add(options.onFrame);
    }
    if (options.onError) {
        errorHandlers.add(options.onError);
    }
    if (options.onStateChange) {
        stateHandlers.add(options.onStateChange);
    }

    throwIfRealtimeAborted(options.signal);
    let unlinkAbortSignal = () => {};
    unlinkAbortSignal = bindAbortSignal(options.signal, () => {
        void closeSession();
    });

    try {
        const submitOperation = await client.submitStream(usda);
        const operationId = submitOperation.operationId;
        if (operationId === undefined || operationId === null || String(operationId).length === 0) {
            const apiError = submitOperation.error;
            if (apiError) {
                throw new RenderCloudError(
                    apiError.message ?? 'Render Cloud stream creation failed.',
                    apiError.code,
                    apiError,
                );
            }

            const gatewayMessage = readGatewayErrorMessage(submitOperation);
            if (gatewayMessage) {
                throw new RenderCloudError(gatewayMessage, 0, submitOperation);
            }
            throw new RenderCloudError('Render Cloud did not return an operationId.', 0, submitOperation);
        }

        sessionId = String(operationId);
        options.onSessionId?.(sessionId);
        throwIfRealtimeAborted(options.signal);

        setState('polling');
        const streamResult = await pollStreamUntilActive(client, sessionId, pollInterval, pollTimeout, options.signal);
        const activeSessionId = streamResult.sessionId || sessionId;
        if (activeSessionId !== sessionId) {
            sessionId = activeSessionId;
            options.onSessionId?.(sessionId);
        }

        const wsUrl = resolveStreamingUrl(
            buildStreamingWebSocketUrl(streamResult.host, streamResult.nodeId, streamResult.token),
            resolved,
        );

        throwIfRealtimeAborted(options.signal);
        setState('connecting');
        await connectStreaming(wsUrl, streamResult.streamId);
        throwIfRealtimeAborted(options.signal);
        setState('ready');

        return {
            get sessionId() {
                return sessionId;
            },
            get state() {
                return state;
            },
            ready() {
                return readyPromise ?? Promise.resolve();
            },
            push(nextUsda) {
                usda = nextUsda;
                schedulePatch();
            },
            pushCamera(camera, patchOptions) {
                usda = patchUsdCamera(usda, camera, patchOptions);
                schedulePatch();
            },
            onFrame(handler) {
                frameHandlers.add(handler);
                return () => frameHandlers.delete(handler);
            },
            onError(handler) {
                errorHandlers.add(handler);
                return () => errorHandlers.delete(handler);
            },
            onStateChange(handler) {
                stateHandlers.add(handler);
                return () => stateHandlers.delete(handler);
            },
            close: () => closeSession(),
        };
    } catch (error) {
        if (sessionId) {
            await closeSession();
        } else {
            unlinkAbortSignal();
        }
        throw error;
    }

    function setState(next: SessionState): void {
        state = next;
        for (const handler of stateHandlers) {
            handler(next);
        }
    }

    function emitError(error: unknown): void {
        setState('error');
        for (const handler of errorHandlers) {
            handler(error);
        }
    }

    function emitFrame(frame: RenderFrame): void {
        for (const handler of frameHandlers) {
            handler(frame);
        }
    }

    function schedulePatch(): void {
        if (closed) {
            return;
        }
        pendingPatch = true;
        if (patchTimer !== undefined) {
            return;
        }

        const delay = Math.max(0, patchThrottleMs - (Date.now() - lastPatchAt));
        patchTimer = setTimeout(() => {
            patchTimer = undefined;
            void flushPatch();
        }, delay);
    }

    async function flushPatch(): Promise<void> {
        if (!pendingPatch || closed) {
            return;
        }

        const waitMs = rateLimiter.msUntilNextSlot();
        if (waitMs > 0) {
            patchTimer = setTimeout(() => {
                patchTimer = undefined;
                void flushPatch();
            }, waitMs);
            return;
        }

        pendingPatch = false;
        rateLimiter.record();
        lastPatchAt = Date.now();

        try {
            await client.pushStream(sessionId, usda);
        } catch (error) {
            emitError(error);
        }

        if (pendingPatch) {
            schedulePatch();
        }
    }

    async function connectStreaming(url: string, streamId: string): Promise<void> {
        readyPromise = new Promise<void>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                reject(new Error('Timed out waiting for Render Cloud streaming to become ready.'));
            }, pollTimeout);

            streaming = new StreamingConnection({
                url,
                streamId,
                WebSocket: resolved.WebSocket,
                onFrame: frame => {
                    if (!settled && waitForFirstFrame) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                    emitFrame(frame);
                },
                onStatus: status => {
                    options.onStreamingStatus?.(status);
                    if (!waitForFirstFrame && status.code === '0' && !settled) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                },
                onError: error => {
                    clearTimeout(timeout);
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                },
                onClose: () => {
                    clearTimeout(timeout);
                    if (!settled) {
                        settled = true;
                        reject(
                            closed
                                ? createRealtimeAbortError()
                                : new Error('Render Cloud streaming WebSocket closed before ready.'),
                        );
                    }
                    if (!closed) {
                        setState('closed');
                    }
                },
            });
        });

        await readyPromise;
    }

    async function closeSession(): Promise<void> {
        if (closed && (serverCloseStarted || !sessionId)) {
            return;
        }
        closed = true;
        unlinkAbortSignal();
        if (patchTimer !== undefined) {
            clearTimeout(patchTimer);
            patchTimer = undefined;
        }

        streaming?.close(1000, 'client-close');
        streaming = undefined;

        if (!sessionId || serverCloseStarted) {
            setState('closed');
            return;
        }

        serverCloseStarted = true;
        try {
            await client.closeStream(sessionId);
        } catch (error) {
            emitError(error);
        }

        setState('closed');
    }
}

async function pollStreamUntilActive(
    client: RenderCloudClient,
    operationId: string | number,
    intervalMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<RealtimeStreamResult> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        throwIfRealtimeAborted(signal);
        const operation = await client.pollStream(operationId);
        throwIfRealtimeAborted(signal);

        if (operation.done && operation.error) {
            const apiError = operation.error;
            throw new RenderCloudError(
                apiError.message ?? 'Render Cloud stream creation failed.',
                apiError.code,
                apiError,
            );
        }

        if (operation.done && operation.result) {
            const result = operation.result;

            if (result.status === 'FAILED' || result.status === 'CLOSED') {
                throw new RenderCloudError(`Render Cloud stream creation failed (${result.status}).`, 0, result);
            }

            if (result.status === 'ACTIVE' && result.host && result.nodeId && result.streamId && result.token) {
                return {
                    sessionId: result.sessionId ?? String(operationId),
                    status: result.status,
                    currentQueuePosition: result.currentQueuePosition,
                    host: result.host,
                    nodeId: result.nodeId,
                    streamId: result.streamId,
                    token: result.token,
                };
            }

            throw new Error(
                `Render Cloud stream ended without ACTIVE credentials (status=${result.status ?? 'unknown'}).`,
            );
        }

        await sleepWithAbort(intervalMs, signal);
    }

    throw new Error('Timed out waiting for Render Cloud stream to become ACTIVE.');
}

function resolveStreamingUrl(url: string, resolved: { transformStreamingUrl?: (url: string) => string }): string {
    return resolved.transformStreamingUrl ? resolved.transformStreamingUrl(url) : url;
}

function bindAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
    if (!signal) {
        return () => {};
    }

    if (signal.aborted) {
        onAbort();
        return () => {};
    }

    signal.addEventListener('abort', onAbort, { once: true });
    return () => {
        signal.removeEventListener('abort', onAbort);
    };
}

async function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) {
        await sleep(ms);
        return;
    }

    throwIfRealtimeAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timeout);
            reject(createRealtimeAbortError());
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}

function throwIfRealtimeAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createRealtimeAbortError();
    }
}

function createRealtimeAbortError(): Error {
    return new DOMException('Render Cloud realtime session was aborted.', 'AbortError');
}
