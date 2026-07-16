import { Readable, type Duplex, type Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ByteLengthQueuingStrategy, WritableStream } from 'node:stream/web';
import { deferred } from './deferred.js';

export function writableToWeb(writable: Writable) {
    return new WritableStream<Uint8Array>(
        {
            async write(chunk) {
                const d = deferred();
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
                        const d2 = deferred();
                        writable.once('drain', () => d2.resolve());
                        await Promise.all([d.promise, d2.promise]);
                        return;
                    } else {
                        return d.promise;
                    }
                }
                return d.promise;
            },

            close() {
                const completion = finished(writable, {
                    readable: false,
                    cleanup: true,
                });

                writable.end();
                return completion;
            },

            abort(reason) {
                writable.destroy(
                    reason instanceof Error
                        ? reason
                        : new Error('WritableStream aborted', {
                              cause: reason,
                          }),
                );
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
