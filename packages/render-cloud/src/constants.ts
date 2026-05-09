/** Documented REST prefix. Default `/rendercloud/v1` (overridable via `RenderCloudConfig.apiPrefix`). */
export const RENDER_CLOUD_V1_PREFIX = '/rendercloud/v1';

/** Paths aligned with OpenAPI `openapi.yaml` (RenderCloud tag). */
export const RENDER_CLOUD_V1_PATHS = {
    offlineJobs: '/jobs',
    streams: '/streams',
    streamPush: (sessionId: string) => `/streams/${encodeURIComponent(sessionId)}:push`,
    streamClose: (sessionId: string) => `/streams/${encodeURIComponent(sessionId)}`,
} as const;

/** OpenAPI WebSocket binary image frames are JPEG (`event.data` Blob). */
export const RENDER_CLOUD_STREAM_FRAME_MIME = 'image/jpeg';

/** Realtime `:push` rolling cap (service limit: 60/min). */
export const RENDER_CLOUD_DEFAULT_MAX_PATCHES_PER_MINUTE = 60;

/** Minimum gap between `:push` calls when throttling (≈1/s sustained at 60/min). */
export const RENDER_CLOUD_DEFAULT_PATCH_THROTTLE_MS = 1000;

/** Realtime stream long-edge resolution cap (pixels). */
export const RENDER_CLOUD_MAX_STREAM_RESOLUTION_LONG_EDGE = 1920;
