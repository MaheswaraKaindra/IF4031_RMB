import type { HazardRecord } from '../storage/types.js';
import { redeliverDelayMs, type IDeliveryLedger } from './ledger.js';

export interface RelayMetrics {
    inc(name: string, labels?: Record<string, string>, delta?: number): void;
}

export interface RelaySpan {
    traceparent: string;
    end(ok: boolean, attrs?: Record<string, string | number>): void;
}

export type RelayTracer = (name: string, parentTraceparent: string | undefined, attrs: Record<string, string | number>) => RelaySpan;

export interface RelayResult {
    published: number;
    failed: number;
}

// Publishes every unacknowledged critical entry. A published entry is claimed again after its backoff expires and is
// published again: the receiver deduplicates by delivery key, so a lost message or a lost ACK converges.
export async function relayDeliveries(
    ledger: IDeliveryLedger,
    publish: (event: HazardRecord, traceparent: string | undefined) => Promise<void>,
    metrics: RelayMetrics,
    opts: { batch: number; visibilityMs: number },
    tracer?: RelayTracer,
): Promise<RelayResult> {
    const entries = await ledger.claim(opts.batch, opts.visibilityMs);
    const result: RelayResult = { published: 0, failed: 0 };
    for (const e of entries) {
        const token = e.claim_token!;
        const delay = redeliverDelayMs(e.attempts);
        const span = tracer?.('relay critical', e.traceparent, { hazard_id: e.hazard_id, attempt: e.attempts });
        try {
            await publish(e.event, span?.traceparent ?? e.traceparent);
            await ledger.markPublished(e._id, token, delay);
            span?.end(true);
            result.published++;
            metrics.inc('coastal_relay_total', { outcome: e.attempts > 1 ? 'republished' : 'published' });
        } catch {
            span?.end(false);
            await ledger.release(e._id, token, delay).catch(() => undefined);
            result.failed++;
            metrics.inc('coastal_relay_total', { outcome: 'publish_failed' });
        }
    }
    return result;
}
