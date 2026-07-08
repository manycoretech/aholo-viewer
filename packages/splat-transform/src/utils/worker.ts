import type { Worker } from 'node:worker_threads';

export type PooledWorker = Worker & {
    readonly alive: boolean;
    readonly busy: boolean;
    readonly permanent: boolean;
    release(): void;
};

interface WorkerSlot {
    worker: PooledWorker;
    alive: boolean;
    busy: boolean;
    permanent: boolean;
}

interface WorkerRequest {
    resolve: (worker: PooledWorker) => void;
    reject: (reason: unknown) => void;
}

export class WorkerPool {
    private slots: WorkerSlot[] = [];
    private requests: WorkerRequest[] = [];
    private cleanupTimer: NodeJS.Timeout | undefined = undefined;
    private disposed = false;

    readonly maxWorkerCount: number;
    readonly permanentWorkers: number;
    readonly cleanupTimeout: number;

    constructor(
        readonly name: string,
        private readonly createWorker: () => Worker,
        maxWorkerCount = 1,
        permanentWorkers = 0,
        cleanupTimeout = 30000,
    ) {
        this.maxWorkerCount = Math.max(1, Math.floor(maxWorkerCount));
        this.permanentWorkers = Math.min(this.maxWorkerCount, Math.max(0, Math.floor(permanentWorkers)));
        this.cleanupTimeout = Math.max(0, cleanupTimeout);
    }

    get workerCount(): number {
        return this.slots.length;
    }

    get pendingTaskCount(): number {
        return this.requests.length;
    }

    private createSlot(): WorkerSlot {
        const slot: WorkerSlot = {
            worker: this.createWorker() as PooledWorker,
            alive: true,
            busy: false,
            permanent: this.slots.length < this.permanentWorkers,
        };

        Object.defineProperties(slot.worker, {
            alive: {
                get: () => slot.alive,
                enumerable: true,
                configurable: false,
            },
            busy: {
                get: () => slot.busy,
                enumerable: true,
                configurable: false,
            },
            permanent: {
                get: () => slot.permanent,
                enumerable: true,
                configurable: false,
            },
            release: {
                value: () => {
                    if (!slot.busy) {
                        return;
                    }
                    slot.busy = false;
                    this.flush();
                },
                enumerable: false,
                configurable: false,
            },
        });

        slot.worker.once('exit', () => {
            slot.alive = false;
            slot.busy = false;
            const index = this.slots.indexOf(slot);
            if (index >= 0) {
                this.slots.splice(index, 1);
            }
            if (!this.disposed) {
                this.flush();
            }
        });

        this.slots.push(slot);
        return slot;
    }

    private takeSlot(): WorkerSlot | undefined {
        const slot = this.slots.find(s => s.alive && !s.busy);
        if (slot) {
            slot.busy = true;
            return slot;
        }
        if (this.slots.length < this.maxWorkerCount) {
            const created = this.createSlot();
            created.busy = true;
            return created;
        }
        return undefined;
    }

    private scheduleCleanup(): void {
        if (this.cleanupTimer != null || this.slots.length <= this.permanentWorkers) {
            return;
        }
        this.cleanupTimer = globalThis.setTimeout(() => {
            this.cleanupIdleWorkers();
        }, this.cleanupTimeout);
    }

    private cleanupIdleWorkers(): void {
        this.cleanupTimer = undefined;
        if (this.disposed || this.slots.length <= this.permanentWorkers) {
            return;
        }

        const slots = this.slots;
        this.slots = [];
        for (const slot of slots) {
            if (!slot.alive) {
                continue;
            }
            if (slot.busy || slot.permanent) {
                this.slots.push(slot);
                continue;
            }
            slot.alive = false;
            void slot.worker.terminate();
        }
    }

    flush(): void {
        if (this.disposed) {
            return;
        }

        while (this.requests.length > 0) {
            const slot = this.takeSlot();
            if (!slot) {
                return;
            }
            this.requests.shift()!.resolve(slot.worker);
        }

        this.scheduleCleanup();
    }

    getWorker(): Promise<PooledWorker> {
        if (this.disposed) {
            return Promise.reject(new Error(`Worker pool "${this.name}" has been disposed`));
        }
        if (this.cleanupTimer != null) {
            globalThis.clearTimeout(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }

        const slot = this.takeSlot();
        if (slot) {
            return Promise.resolve(slot.worker);
        }

        return new Promise<PooledWorker>((resolve, reject) => {
            this.requests.push({ resolve, reject });
        });
    }

    async using<T>(fn: (worker: PooledWorker) => T | Promise<T>): Promise<T> {
        const worker = await this.getWorker();
        try {
            return await fn(worker);
        } finally {
            worker.release();
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.cleanupTimer != null) {
            globalThis.clearTimeout(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }

        const reason = new Error(`Worker pool "${this.name}" has been disposed`);
        for (const request of this.requests.splice(0)) {
            request.reject(reason);
        }

        const slots = this.slots.splice(0);
        await Promise.allSettled(
            slots.map(slot => {
                slot.alive = false;
                slot.busy = false;
                return slot.worker.terminate();
            }),
        );
    }
}
