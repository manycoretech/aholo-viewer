import { RENDER_CLOUD_MAX_STREAM_RESOLUTION_LONG_EDGE } from './constants';
import type { RenderCloudApiError, RenderCloudErrorDetails } from './types';

export class RenderCloudError extends Error {
    readonly status: number;
    readonly body?: RenderCloudApiError | unknown;

    constructor(message: string, status: number, body?: RenderCloudApiError | unknown) {
        super(message);
        this.name = 'RenderCloudError';
        this.status = status;
        this.body = body;
    }
}

export function createRequestId(prefix = 'rc'): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

/**
 * Beta gateway `{ c, m }` envelope.
 * Returns a failure message when `c` is present and not a success code (`0` / `200`).
 */
export function readLegacyGatewayFailure(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        return undefined;
    }

    const record = body as Record<string, unknown>;
    if (!('c' in record)) {
        return undefined;
    }

    const code = String(record.c ?? '');
    if (code === '0' || code === '200') {
        return undefined;
    }

    const message = record.m;
    return typeof message === 'string' && message.trim() ? message.trim() : `gateway error (${code})`;
}

function unwrapRenderCloudApiErrorRecord(body: unknown): Record<string, unknown> | undefined {
    if (!body || typeof body !== 'object') {
        return undefined;
    }

    const record = body as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === 'object') {
        return nested as Record<string, unknown>;
    }

    if ('message' in record || 'code' in record || 'status' in record || 'details' in record) {
        return record;
    }

    return undefined;
}

/** `Operation.error` / HTTP `RenderCloudApiError.details`. */
export function readRenderCloudApiErrorDetails(body: unknown): RenderCloudErrorDetails | undefined {
    const record = unwrapRenderCloudApiErrorRecord(body);
    if (!record) {
        return undefined;
    }

    const details = record.details;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
        return details as RenderCloudErrorDetails;
    }

    return undefined;
}

/** `details.reason` per OpenAPI (`UPPER_SNAKE_CASE`). */
export function readRenderCloudApiErrorReason(body: unknown): string | undefined {
    const reason = readRenderCloudApiErrorDetails(body)?.reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}

/** `Operation.error.message` or top-level `RenderCloudApiError.message`. */
export function readRenderCloudApiErrorMessage(body: unknown): string | undefined {
    const record = unwrapRenderCloudApiErrorRecord(body);
    if (!record) {
        return undefined;
    }

    const message = record.message;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

/**
 * User-facing error text aligned with OpenAPI `RenderCloudApiError`:
 * prefer `message` (human-readable), then `details.reason`.
 */
export function formatRenderCloudUserError(body: unknown, options?: { fallbackMessage?: string }): string | undefined {
    const message = readRenderCloudApiErrorMessage(body);
    const reason = readRenderCloudApiErrorReason(body);
    return message ?? reason ?? options?.fallbackMessage;
}

/** Failure text from a gateway body (legacy `{ c, m }`, `Operation.error`, or `RenderCloudApiError`). */
export function readGatewayErrorMessage(body: unknown): string | undefined {
    const legacy = readLegacyGatewayFailure(body);
    if (legacy) {
        return legacy;
    }

    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (record.error) {
            const operationError = readRenderCloudApiErrorMessage(record.error);
            if (operationError) {
                return operationError;
            }
        }
    }

    return readRenderCloudApiErrorMessage(body);
}

export function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

export function normalizeAppKey(key: string): string {
    return key.replace(/^Bearer\s+/i, '').trim();
}

/** Clamp stream resolution so the long edge does not exceed the service limit. */
export function clampStreamResolution(
    size: { width: number; height: number },
    maxLongEdge = RENDER_CLOUD_MAX_STREAM_RESOLUTION_LONG_EDGE,
): { width: number; height: number } {
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const longEdge = Math.max(width, height);
    if (longEdge <= maxLongEdge) {
        return { width, height };
    }

    const scale = maxLongEdge / longEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

export class PatchRateLimiter {
    readonly #maxPerMinute: number;
    #timestamps: number[] = [];

    constructor(maxPerMinute: number) {
        this.#maxPerMinute = maxPerMinute;
    }

    msUntilNextSlot(): number {
        const now = Date.now();
        this.#timestamps = this.#timestamps.filter(t => now - t < 60_000);
        if (this.#timestamps.length < this.#maxPerMinute) {
            return 0;
        }
        return Math.max(0, 60_000 - (now - this.#timestamps[0]!));
    }

    record(): void {
        this.#timestamps.push(Date.now());
    }
}
