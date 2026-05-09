/**
 * Render Cloud types aligned with AHOLO OpenAPI (`openapi.yaml`, RenderCloud tag).
 */

export interface RenderCloudConfig {
    /**
     * API gateway origin (e.g. `https://api.aholo3d.cn` production, `https://api-beta.aholo3d.cn` beta).
     */
    origin: string;
    /**
     * REST path prefix before `/streams`, `/jobs`, etc.
     * Default `/rendercloud/v1` (OpenAPI RenderCloud v1). Override only for non-standard gateways.
     */
    apiPrefix?: string;
    /**
     * Aholo Open Platform AppKey HTTP header `Authorization: <AppKey>` (no `Bearer` prefix).
     * @see https://labs.aholo3d.cn/api-docs/api-reference
     */
    getAppKey?: () => string | Promise<string>;
    /** Rewrite WebSocket URL before connect. */
    transformStreamingUrl?: (url: string) => string;
    /** Log each HTTP request/response to `console` (for local debugging). */
    debug?: boolean;
    fetch?: typeof fetch;
    WebSocket?: typeof WebSocket;
    createRequestId?: () => string;
}

/** `components.schemas.OperationMetaData` often `null` while processing. */
export type OperationMetaData = Record<string, unknown> | null;

export type RenderCloudErrorStatus = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'RESOURCE_EXHAUSTED' | 'INTERNAL' | string;

/** `components.schemas.RenderCloudErrorDetails` */
export interface RenderCloudErrorDetails {
    reason?: string;
    domain?: string;
    [key: string]: unknown;
}

/**
 * Render Cloud gateway error (`components.schemas.RenderCloudApiError`).
 * Used for HTTP error responses and `Operation.error` when `done=true`.
 */
export interface RenderCloudApiError {
    code: number;
    message: string;
    status: RenderCloudErrorStatus;
    details?: RenderCloudErrorDetails;
    [key: string]: unknown;
}

/** OpenAPI `imgSize` (`x` = width, `y` = height in pixels). Prefer `{ width, height }` on {@link OfflineRenderClient.submitJob}. */
export interface Int2 {
    x: number;
    y: number;
}

/** Long-running operation poll body — only `operationId`. */
export interface OperationPollRequest {
    operationId: string | number;
}

export interface Operation<TResult = Record<string, unknown>> {
    operationId: string | number;
    /** Extension metadata; OpenAPI examples use `null` while processing. */
    metaData?: OperationMetaData;
    done: boolean;
    result?: TResult | null;
    error?: RenderCloudApiError | null;
}

/** `POST /rendercloud/v1/jobs` submit. */
export interface OfflineRenderSubmitRequest {
    requestId: string;
    usdContent: string;
    imgSize: Int2;
}

export interface OfflineRenderResult {
    taskId?: string;
    resultUrl?: string;
}

/** `POST /rendercloud/v1/streams` submit. */
export interface RealtimeStreamSubmitRequest {
    requestId: string;
    usdContent: string;
}

export type RenderCloudSessionStatus =
    | 'RENDER_CLOUD_SESSION_STATUS_UNSPECIFIED'
    | 'INITIALIZING'
    | 'ACTIVE'
    | 'FAILED'
    | 'CLOSED'
    | string;

/** `RealtimeSessionSuccessOperation.result` when `status=ACTIVE`. */
export interface RealtimeStreamResult {
    sessionId: string;
    status: RenderCloudSessionStatus;
    currentQueuePosition?: number;
    host: string;
    nodeId: string;
    streamId: string;
    token: string;
}

/** `POST /rendercloud/v1/streams/{sessionId}:push` */
export interface RealtimeStreamUpdateRequest {
    requestId: string;
    usdContent: string;
}

export interface RealtimeStreamUpdateResponse {
    sessionId: string;
    status: RenderCloudSessionStatus;
}

export interface RealtimeStreamCloseResponse {
    sessionId: string;
    closed: boolean;
}

export type SessionState = 'idle' | 'creating' | 'polling' | 'connecting' | 'ready' | 'closed' | 'error';

export interface RenderFrame {
    kind: 'image';
    /** OpenAPI: WebSocket binary message (`Blob`), always JPEG. */
    data: Blob;
    /** Fixed `image/jpeg` for spec-compliant streaming frames. */
    mimeType: string;
    timestamp: number;
    frameId?: string;
}

export interface StreamingStatusMessage {
    code: string;
    desc?: string;
    streamId?: string;
    timestamp?: number;
    queueInfo?: {
        queueSize?: number;
        currentQueuePosition?: number;
    };
}

export interface RealtimeSessionOptions {
    usda: string;
    /** Abort session creation and close any server session that was already allocated. */
    signal?: AbortSignal;
    /** Poll interval when waiting for stream ACTIVE. OpenAPI suggests 2s. */
    poll?: {
        intervalMs?: number;
        timeoutMs?: number;
    };
    /**
     * Client-side cap on `:push` per rolling minute (not in OpenAPI).
     * Default `60` (service limit).
     */
    maxPatchesPerMinute?: number;
    /** Minimum ms between `:push` calls (debounce). Default `1000`. Not in OpenAPI. */
    patchThrottleMs?: number;
    /** Invoked as soon as frames arrive (including during {@link createRealtimeSession}). */
    onFrame?: (frame: RenderFrame) => void;
    onError?: (error: unknown) => void;
    onStateChange?: (state: SessionState) => void;
    /** OpenAPI returns `operationId` as the realtime `sessionId` before the session becomes ACTIVE. */
    onSessionId?: (sessionId: string) => void;
    /** WebSocket JSON status (`code`, `desc`, queue info). Includes render errors `2001` / `2002`. */
    onStreamingStatus?: (message: StreamingStatusMessage) => void;
    /**
     * When true, {@link createRealtimeSession} resolves only after the first image frame.
     * Default false: resolves on streaming status `code === "0"` (WS ready, frames may still be 0).
     */
    waitForFirstFrame?: boolean;
}

export type UsdMatrix4d = [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
];

export interface UsdCameraParams {
    /** USD `matrix4d xformOp:transform` rows (preferred for Labs Z-up scenes). */
    transform?: UsdMatrix4d;
    /** Legacy translate/rotate camera rigs. */
    translate?: [number, number, number];
    rotateXYZ?: [number, number, number];
    focalLength: number;
    horizontalAperture: number;
    verticalAperture: number;
    resolution: { width: number; height: number };
}
