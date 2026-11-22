export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
    failureThreshold: number;
    windowMs: number;
    openMs: number;
    maxOpenMs: number;
    backoffFactor: number;
    jitter: number; // fraction of the open interval, 0..1
    halfOpenProbes: number;
    now?: () => number;
    random?: () => number;
    onTransition?: (from: BreakerState, to: BreakerState, reason: string) => void;
}

export const DEFAULT_BREAKER: Omit<BreakerOptions, 'now' | 'random' | 'onTransition'> = {
    failureThreshold: 5,
    windowMs: 30_000,
    openMs: 2_000,
    maxOpenMs: 5_000,
    backoffFactor: 2,
    jitter: 0.2,
    halfOpenProbes: 1,
};

export class CircuitBreaker {
    private readonly opts: BreakerOptions;
    private readonly now: () => number;
    private readonly random: () => number;
    private current: BreakerState = 'closed';
    private failures: number[] = [];
    private openUntil = 0;
    private openInterval: number;
    private probesInFlight = 0;
    readonly counters = { opened: 0, rejected: 0, successes: 0, failures: 0 };

    constructor(opts: BreakerOptions) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.random = opts.random ?? Math.random;
        this.openInterval = opts.openMs;
    }

    get state(): BreakerState {
        this.refresh();
        return this.current;
    }

    retryInMs(): number {
        this.refresh();
        return this.current === 'open' ? Math.max(0, this.openUntil - this.now()) : 0;
    }

    // Returns true when the caller may send a request. A half-open permit must be settled by onSuccess/onFailure.
    allow(): boolean {
        this.refresh();
        if (this.current === 'closed') return true;
        if (this.current === 'half_open' && this.probesInFlight < this.opts.halfOpenProbes) {
            this.probesInFlight++;
            return true;
        }
        this.counters.rejected++;
        return false;
    }

    onSuccess(): void {
        this.counters.successes++;
        if (this.current === 'half_open') {
            this.probesInFlight = Math.max(0, this.probesInFlight - 1);
            this.openInterval = this.opts.openMs;
            this.failures = [];
            this.transition('closed', 'probe_succeeded');
            return;
        }
        if (this.current === 'closed') this.failures = [];
    }

    onFailure(reason = 'failure'): void {
        this.counters.failures++;
        const t = this.now();
        if (this.current === 'half_open') {
            this.probesInFlight = Math.max(0, this.probesInFlight - 1);
            this.openInterval = Math.min(this.opts.maxOpenMs, this.openInterval * this.opts.backoffFactor);
            this.open(`probe_failed:${reason}`);
            return;
        }
        if (this.current === 'open') return;
        this.failures.push(t);
        this.failures = this.failures.filter((f) => t - f <= this.opts.windowMs);
        if (this.failures.length >= this.opts.failureThreshold) this.open(reason);
    }

    private open(reason: string): void {
        const spread = this.openInterval * this.opts.jitter;
        this.openUntil = this.now() + this.openInterval + (this.random() * 2 - 1) * spread;
        this.failures = [];
        this.counters.opened++;
        this.transition('open', reason);
    }

    private refresh(): void {
        if (this.current === 'open' && this.now() >= this.openUntil) {
            this.probesInFlight = 0;
            this.transition('half_open', 'open_interval_elapsed');
        }
    }

    private transition(to: BreakerState, reason: string): void {
        const from = this.current;
        if (from === to) return;
        this.current = to;
        this.opts.onTransition?.(from, to, reason);
    }
}
