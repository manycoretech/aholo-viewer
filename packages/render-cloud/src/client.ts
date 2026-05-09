import { RENDER_CLOUD_V1_PATHS } from './constants';
import type {
    Int2,
    OfflineRenderResult,
    OfflineRenderSubmitRequest,
    Operation,
    OperationPollRequest,
    RealtimeStreamCloseResponse,
    RealtimeStreamResult,
    RealtimeStreamSubmitRequest,
    RealtimeStreamUpdateRequest,
    RealtimeStreamUpdateResponse,
    RenderCloudConfig,
} from './types';
import { createRequestId, normalizeAppKey, readLegacyGatewayFailure, RenderCloudError, safeJsonParse } from './utils';
import { encodeUsdToBase64 } from './usd';

interface ResolvedRenderCloudConfig {
    origin: string;
    apiPrefix: string;
    getAppKey?: () => string | Promise<string>;
    transformStreamingUrl?: (url: string) => string;
    fetch: typeof fetch;
    WebSocket: typeof WebSocket;
    createRequestId: () => string;
    debug: boolean;
}

function resolveConfig(config: RenderCloudConfig): ResolvedRenderCloudConfig {
    return {
        origin: config.origin.replace(/\/$/, ''),
        apiPrefix: config.apiPrefix ?? '/rendercloud/v1',
        getAppKey: config.getAppKey,
        transformStreamingUrl: config.transformStreamingUrl,
        fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
        WebSocket: config.WebSocket ?? globalThis.WebSocket,
        createRequestId: config.createRequestId ?? createRequestId,
        debug: config.debug ?? false,
    };
}

/**
 * Thin REST client for OpenAPI Render Cloud v1 (`/rendercloud/v1/*`).
 * Realtime JPEG frames are delivered on WebSocket — see {@link createRealtimeSession}.
 */
export class RenderCloudClient {
    readonly #config: ResolvedRenderCloudConfig;

    constructor(config: RenderCloudConfig) {
        this.#config = resolveConfig(config);
    }

    get resolved(): ResolvedRenderCloudConfig {
        return this.#config;
    }

    /** `POST /rendercloud/v1/streams` — submit (no `operationId`). */
    submitStream(usda: string, requestId?: string): Promise<Operation<RealtimeStreamResult>> {
        const body: RealtimeStreamSubmitRequest = {
            requestId: requestId ?? this.#config.createRequestId(),
            usdContent: encodeUsdToBase64(usda),
        };
        return this.json(RENDER_CLOUD_V1_PATHS.streams, { method: 'POST', json: body });
    }

    /** `POST /rendercloud/v1/streams` — poll (`operationId` only). */
    pollStream(operationId: string | number): Promise<Operation<RealtimeStreamResult>> {
        const body: OperationPollRequest = { operationId };
        return this.json(RENDER_CLOUD_V1_PATHS.streams, { method: 'POST', json: body });
    }

    /** `POST /rendercloud/v1/streams/{sessionId}:push` — scene/camera updates. */
    pushStream(sessionId: string, usda: string, requestId?: string): Promise<RealtimeStreamUpdateResponse> {
        const body: RealtimeStreamUpdateRequest = {
            requestId: requestId ?? this.#config.createRequestId(),
            usdContent: encodeUsdToBase64(usda),
        };
        return this.json(RENDER_CLOUD_V1_PATHS.streamPush(sessionId), { method: 'POST', json: body });
    }

    /** `DELETE /rendercloud/v1/streams/{sessionId}`. */
    closeStream(sessionId: string): Promise<RealtimeStreamCloseResponse> {
        return this.json(RENDER_CLOUD_V1_PATHS.streamClose(sessionId), { method: 'DELETE' });
    }

    /** `POST /rendercloud/v1/jobs` — submit offline render. */
    submitOfflineJob(usda: string, imgSize: Int2, requestId?: string): Promise<Operation<OfflineRenderResult>> {
        const body: OfflineRenderSubmitRequest = {
            requestId: requestId ?? this.#config.createRequestId(),
            usdContent: encodeUsdToBase64(usda),
            imgSize,
        };
        return this.json(RENDER_CLOUD_V1_PATHS.offlineJobs, { method: 'POST', json: body });
    }

    /** `POST /rendercloud/v1/jobs` — poll offline job. */
    pollOfflineJob(operationId: string | number): Promise<Operation<OfflineRenderResult>> {
        const body: OperationPollRequest = { operationId };
        return this.json(RENDER_CLOUD_V1_PATHS.offlineJobs, { method: 'POST', json: body });
    }

    async json<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
        const headers = new Headers(init?.headers);
        headers.set('Content-Type', 'application/json');
        await applyAuthHeaders(headers, this.#config);

        const url = buildRequestUrl(this.#config.origin, this.#config.apiPrefix, path);
        const method = init?.method ?? 'GET';

        if (this.#config.debug) {
            console.group(`[render-cloud] ${method} ${url}`);
            if (init?.json !== undefined) {
                console.log('request body', init.json);
            }
        }

        const response = await this.#config.fetch(url, {
            ...init,
            headers,
            body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
        });

        const text = await response.text();
        const body = text ? safeJsonParse(text) : undefined;

        if (this.#config.debug) {
            console.log('status', response.status, response.statusText);
            console.log('response', body ?? text);
            console.groupEnd();
        }

        if (!response.ok) {
            throw new RenderCloudError(formatErrorMessage(response.status, body, text), response.status, body);
        }

        const legacyMessage = readLegacyGatewayFailure(body);
        if (legacyMessage) {
            throw new RenderCloudError(`Render Cloud: ${legacyMessage}`, response.status, body);
        }

        return body as T;
    }
}

async function applyAuthHeaders(headers: Headers, config: ResolvedRenderCloudConfig): Promise<void> {
    if (!config.getAppKey) {
        return;
    }

    const key = normalizeAppKey((await config.getAppKey()).trim());
    if (!key) {
        return;
    }

    headers.set('Authorization', key);
}

function buildRequestUrl(origin: string, apiPrefix: string, path: string): string {
    return `${origin.replace(/\/$/, '')}${apiPrefix}${path}`;
}

/**
 * Fire-and-forget `DELETE /rendercloud/v1/streams/{sessionId}` with `fetch({ keepalive: true })`.
 * Use on `pagehide` / `beforeunload` when `RealtimeSession.close()` may not finish.
 * Pass `appKey` synchronously (unload handlers cannot await `config.getAppKey`).
 */
export function closeStreamKeepalive(config: RenderCloudConfig, sessionId: string, appKey: string): void {
    const resolved = resolveConfig(config);
    const key = normalizeAppKey(appKey.trim());
    if (!key || !sessionId) {
        return;
    }

    const url = buildRequestUrl(resolved.origin, resolved.apiPrefix, RENDER_CLOUD_V1_PATHS.streamClose(sessionId));

    void resolved.fetch(url, {
        method: 'DELETE',
        headers: { Authorization: key },
        keepalive: true,
    });
}

function formatErrorMessage(status: number, body: unknown, rawText: string): string {
    if (typeof body === 'object' && body !== null && 'message' in body) {
        return String((body as { message: unknown }).message);
    }

    const text = typeof body === 'string' ? body : rawText;
    if (text.trim().startsWith('<!') || text.includes('<html')) {
        return `Unexpected HTML response (${status}). Check that \`origin\` points at the Render Cloud API gateway, not a static site.`;
    }

    if (typeof body === 'string' && body.trim()) {
        return body.trim();
    }

    if (rawText.trim()) {
        return rawText.trim();
    }

    return `Render Cloud request failed (${status})`;
}
