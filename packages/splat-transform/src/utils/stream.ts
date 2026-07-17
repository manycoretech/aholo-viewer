import { Readable, type Duplex, type Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ByteLengthQueuingStrategy, WritableStream } from 'node:stream/web';
import { deferred, type Deferred } from './deferred.js';

function taggedError(tag: string, reason: unknown) {
    return reason instanceof Error
        ? reason
        : new Error(tag, {
              cause: reason,
          });
}

export function writableToWeb(writable: Writable) {
    let drainWait: Deferred<void> | undefined = undefined;
    let controller: WritableStreamDefaultController | undefined = undefined;
    function onDrain() {
        drainWait?.resolve();
        drainWait = undefined;
    }

    function onUnexpected(reason: any) {
        const error = taggedError('Writable closed', reason);
        drainWait?.reject(error);
        drainWait = undefined;
        controller?.error(error);
        cleanup();
    }

    function onAbort() {
        drainWait?.reject(taggedError('WritableStream aborted', controller?.signal.reason));
        drainWait = undefined;
        cleanup();
    }

    function cleanup() {
        writable.off('drain', onDrain);
        writable.off('close', onUnexpected);
        writable.off('error', onUnexpected);
        controller?.signal.removeEventListener('abort', onAbort);
        controller = undefined;
    }

    writable.on('drain', onDrain);
    writable.once('close', onUnexpected);
    writable.once('error', onUnexpected);

    const completion = finished(writable, {
        readable: false,
        cleanup: true,
    });
    completion.then(onUnexpected, onUnexpected);

    return new WritableStream<Uint8Array>(
        {
            start(c) {
                controller = c as any;
                controller!.signal.addEventListener('abort', onAbort, {
                    once: true,
                });
            },
            async write(chunk) {
                const d = deferred();
                if (writable.writableNeedDrain) {
                    if (!drainWait) {
                        drainWait = deferred();
                    }
                    await drainWait.promise;
                }
                if (
                    !writable.write(chunk, error => {
                        if (error) {
                            d.reject(error);
                        } else {
                            d.resolve();
                        }
                    })
                ) {
                    if (writable.writableNeedDrain) {
                        if (!drainWait) {
                            drainWait = deferred();
                        }
                        await Promise.all([d.promise, drainWait.promise]);
                        return;
                    } else {
                        return d.promise;
                    }
                }
                return d.promise;
            },
            close() {
                if (controller) {
                    writable.end();
                    cleanup();
                }
                return completion;
            },
            abort(reason) {
                writable.destroy(taggedError('WritableStream aborted', reason));
            },
        },
        new ByteLengthQueuingStrategy({
            highWaterMark: writable.writableHighWaterMark,
        }),
    );
}

export function duplexToWeb(duplex: Duplex): ReadableWritablePair<Uint8Array, Uint8Array> {
    return { readable: Readable.toWeb(duplex) as ReadableStream<Uint8Array>, writable: writableToWeb(duplex) };
}
