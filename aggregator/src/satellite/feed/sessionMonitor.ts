import type { Logger } from 'pino';
import type { IFeedLog } from './log.js';
import type { MetricsLike } from '../metrics.js';

export interface SessionMonitorOptions {
    baseUrl: string;
    token: string;
    log: IFeedLog;
    metrics: MetricsLike;
    logger: Logger;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
}

/** Publishes how far the feed is ahead of what BNPB has stored, so a burst shows up as lag on the dashboard. */
export async function pollSessionOnce(o: SessionMonitorOptions): Promise<void> {
    const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl.replace(/\/$/, '')}/v1/session`, {
        headers: { Authorization: `Bearer ${o.token}` },
        signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`session HTTP ${res.status}`);
    const s = (await res.json()) as { latest_offset?: unknown; virtual_now?: unknown; speed?: unknown };
    const tail = await o.log.tail();
    if (typeof s.latest_offset === 'number') {
        o.metrics.set('satellite_source_latest_offset', {}, s.latest_offset);
        o.metrics.set('satellite_source_offset_lag', {}, Math.max(0, s.latest_offset - tail));
    }
    if (typeof s.virtual_now === 'string') {
        const t = Date.parse(s.virtual_now);
        if (!Number.isNaN(t)) o.metrics.set('satellite_virtual_now_seconds', {}, t / 1000);
    }
    if (typeof s.speed === 'number') o.metrics.set('satellite_feed_speed', {}, s.speed);
}

export async function runSessionMonitor(o: SessionMonitorOptions, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        const started = Date.now();
        try {
            await pollSessionOnce(o);
        } catch (err) {
            const probe = Date.now();
            await new Promise<void>((r) => setImmediate(r));
            const loopLagMs = Date.now() - probe;
            const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
            o.logger.warn(
                { error: err instanceof Error ? err.message : String(err), cause: cause?.code ?? cause?.message, event_loop_lag_ms: loopLagMs, elapsed_ms: Date.now() - started },
                'satellite session poll failed'
            );
            o.metrics.inc('satellite_session_poll_failures_total', {});
            o.metrics.set('satellite_source_offset_lag', {}, Number.NaN);
        }
        await new Promise<void>((resolve) => {
            const t = setTimeout(done, o.intervalMs ?? 5000);
            function done(): void {
                clearTimeout(t);
                signal.removeEventListener('abort', done);
                resolve();
            }
            signal.addEventListener('abort', done, { once: true });
        });
    }
}
