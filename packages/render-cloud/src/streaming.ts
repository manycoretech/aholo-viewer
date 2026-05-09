import { RENDER_CLOUD_STREAM_FRAME_MIME } from './constants';
import type { RenderFrame, StreamingStatusMessage } from './types';

export type FrameHandler = (frame: RenderFrame) => void;
export type StatusHandler = (message: StreamingStatusMessage) => void;

export interface StreamingConnectionOptions {
    url: string;
    streamId: string;
    WebSocket: typeof WebSocket;
    onFrame: FrameHandler;
    onStatus?: StatusHandler;
    onError?: (error: unknown) => void;
    onOpen?: () => void;
    onClose?: (event: CloseEvent) => void;
}

/** OpenAPI: `wss://{host}/streaming/ws/session?nid=...&token=...` */
export function buildStreamingWebSocketUrl(host: string, nodeId: string, token: string): string {
    const nid = encodeURIComponent(nodeId);
    const tok = encodeURIComponent(token);
    return `wss://${host}/streaming/ws/session?nid=${nid}&token=${tok}`;
}

export function decodeStreamingJson(text: string): StreamingStatusMessage | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
        return undefined;
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const code = parsed.code;
    if (code === undefined) {
        return undefined;
    }

    return {
        code: String(code),
        desc: typeof parsed.desc === 'string' ? parsed.desc : undefined,
        streamId: typeof parsed.streamId === 'string' ? parsed.streamId : undefined,
        timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : undefined,
        queueInfo:
            parsed.queueInfo && typeof parsed.queueInfo === 'object'
                ? (parsed.queueInfo as StreamingStatusMessage['queueInfo'])
                : undefined,
    };
}

/**
 * OpenAPI path: WS binary `Blob` {@link RenderFrame}.
 * Spec fixes format as JPEG; no sniffing or re-encoding.
 */
export function decodeStreamingBlob(blob: Blob): RenderFrame | undefined {
    if (blob.size === 0) {
        return undefined;
    }

    return {
        kind: 'image',
        data: blob,
        mimeType: RENDER_CLOUD_STREAM_FRAME_MIME,
        timestamp: Date.now(),
    };
}

export class StreamingConnection {
    readonly #socket: WebSocket;
    readonly #onFrame: FrameHandler;
    readonly #onStatus?: StatusHandler;
    readonly #onError?: (error: unknown) => void;

    constructor(options: StreamingConnectionOptions) {
        this.#onFrame = options.onFrame;
        this.#onStatus = options.onStatus;
        this.#onError = options.onError;
        this.#socket = new options.WebSocket(options.url);
        this.#socket.binaryType = 'blob';

        this.#socket.addEventListener('open', () => {
            this.#socket.send(
                JSON.stringify({
                    type: 3,
                    slaveInit: {
                        masterStreamingId: options.streamId,
                        receiveImage: true,
                    },
                }),
            );
            options.onOpen?.();
        });

        this.#socket.addEventListener('message', event => {
            this.#handleMessage(event.data);
        });

        this.#socket.addEventListener('error', () => {
            this.#onError?.(new Error('Render Cloud streaming WebSocket error'));
        });

        this.#socket.addEventListener('close', event => {
            options.onClose?.(event);
        });
    }

    get readyState(): number {
        return this.#socket.readyState;
    }

    close(code?: number, reason?: string): void {
        if (this.#socket.readyState === WebSocket.CLOSED || this.#socket.readyState === WebSocket.CLOSING) {
            return;
        }
        this.#socket.close(code, reason);
    }

    #handleMessage(data: string | ArrayBuffer | Blob): void {
        try {
            if (typeof data === 'string') {
                const status = decodeStreamingJson(data);
                if (status) {
                    this.#onStatus?.(status);
                    if (isFatalStreamingCode(status.code)) {
                        this.#onError?.(new Error(status.desc ?? `Streaming error ${status.code}`));
                    }
                }
                return;
            }

            if (data instanceof Blob) {
                const frame = decodeStreamingBlob(data);
                if (frame) {
                    this.#onFrame(frame);
                }
                return;
            }

            if (data instanceof ArrayBuffer) {
                const frame = decodeStreamingBlob(new Blob([data], { type: RENDER_CLOUD_STREAM_FRAME_MIME }));
                if (frame) {
                    this.#onFrame(frame);
                }
            }
        } catch (error) {
            this.#onError?.(error);
        }
    }
}

function isFatalStreamingCode(code: string): boolean {
    return code === '1000' || code === '1001' || code === '1003';
}
