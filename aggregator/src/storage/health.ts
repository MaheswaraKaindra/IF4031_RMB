import { logger } from '../logger.js';

// The store keeps two data copies per shard. When a data member is down, a write cannot be confirmed by both ("waiting for
// replication timed out"). The canonical repository answers that with a `degraded` acknowledgement; the coordination and inbox
// bookkeeping (leases, fencing epochs, checkpoints, raw inbox, field-report outbox) used to treat the same timeout as a failure, so a
// failover during a node loss could not commit its epoch and polling stalled until the member came back (measured: no polls at all
// for about 2 minutes after a leader's node was powered off). While the store is degraded those collections now write to the primary
// only (w:1); in a healthy store they keep w:2, so no durability is given up when nothing is wrong.
let degraded = false;

export function setStoreDegraded(value: boolean, detail?: string): void {
    if (degraded === value) return;
    degraded = value;
    logger.warn({ store_degraded: value, detail }, value ? 'store degraded: bookkeeping writes use w:1 until redundancy returns' : 'store redundancy restored: bookkeeping writes use w:2 again');
}

// The background prober (mongoRepository.refreshStatus) is the normal source of `degraded`, but it can be late: during a node loss it must
// first time out its probes. A bookkeeping write that itself fails on the write concern is proof enough, so it also switches the store to
// degraded for a short window (a later failure extends it, the prober can still clear the flag earlier by finding full redundancy).
let reactiveUntilMs = 0;
const REACTIVE_WINDOW_MS = Number(process.env.STORE_DEGRADED_REACTIVE_MS ?? 15_000);

export function isWriteConcernTimeout(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { code?: unknown; codeName?: unknown; message?: unknown; writeConcernError?: unknown };
    if (e.writeConcernError) return true;
    if (e.code === 64 || e.codeName === 'WriteConcernFailed' || e.codeName === 'WriteConcernTimeout') return true;
    return typeof e.message === 'string' && /waiting for replication timed out|wtimeout/i.test(e.message);
}

/** Call from any bookkeeping failure path; returns true when the error was a write concern timeout (and degraded mode was entered). */
export function noteBookkeepingFailure(err: unknown, nowMs: number = Date.now()): boolean {
    if (!isWriteConcernTimeout(err)) return false;
    const wasDegraded = isStoreDegraded(nowMs);
    reactiveUntilMs = nowMs + REACTIVE_WINDOW_MS;
    if (!wasDegraded) logger.warn({ store_degraded: true }, 'a bookkeeping write timed out on its write concern: bookkeeping writes use w:1 for a while');
    return true;
}

export function resetReactiveDegraded(): void {
    reactiveUntilMs = 0;
}

export function isStoreDegraded(nowMs: number = Date.now()): boolean {
    return degraded || nowMs < reactiveUntilMs;
}

/** Collection options for bookkeeping writes; undefined means "use the client default" (single-node store). */
export function bookkeepingOptions(): { writeConcern: { w: number; wtimeoutMS?: number } } | undefined {
    if (process.env.STORE_MODE !== 'sharded') return undefined;
    if (isStoreDegraded()) return { writeConcern: { w: 1 } };
    return { writeConcern: { w: Number(process.env.STORE_WRITE_W ?? 2), wtimeoutMS: Number(process.env.STORE_WRITE_TIMEOUT_MS ?? 1500) } };
}
