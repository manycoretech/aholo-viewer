export interface Deferred<T = void> {
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason: any) => void;
    promise: Promise<T>;
}

export function deferred<T = void>(): Deferred<T> {
    let resolve: (value: T | PromiseLike<T>) => void = () => {};
    let reject: (reason: any) => void = () => {};
    const promise = new Promise<T>(function (resolveInner, rejectInner) {
        resolve = resolveInner;
        reject = rejectInner;
    });
    return {
        promise,
        resolve,
        reject,
    };
}
