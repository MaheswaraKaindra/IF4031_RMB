export class BulkheadFullError extends Error {
    constructor(readonly pool: string) {
        super(`bulkhead ${pool} is full`);
    }
}

// Fixed concurrency pool. Work beyond the limit is rejected, never queued without bound.
export class Bulkhead {
    private inFlight = 0;
    readonly counters = { admitted: 0, rejected: 0 };

    constructor(
        readonly name: string,
        readonly limit: number,
    ) {}

    get active(): number {
        return this.inFlight;
    }

    tryAcquire(): (() => void) | null {
        if (this.inFlight >= this.limit) {
            this.counters.rejected++;
            return null;
        }
        this.inFlight++;
        this.counters.admitted++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.inFlight--;
        };
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        const release = this.tryAcquire();
        if (!release) throw new BulkheadFullError(this.name);
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
