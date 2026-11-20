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

export function isStoreDegraded(): boolean {
    return degraded;
}

/** Collection options for bookkeeping writes; undefined means "use the client default" (single-node store). */
export function bookkeepingOptions(): { writeConcern: { w: number; wtimeoutMS?: number } } | undefined {
    if (process.env.STORE_MODE !== 'sharded') return undefined;
    if (degraded) return { writeConcern: { w: 1 } };
    return { writeConcern: { w: Number(process.env.STORE_WRITE_W ?? 2), wtimeoutMS: Number(process.env.STORE_WRITE_TIMEOUT_MS ?? 1500) } };
}
