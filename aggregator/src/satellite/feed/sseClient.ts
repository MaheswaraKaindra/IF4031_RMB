import type { Logger } from 'pino';
import { decodeFrame, type FeedEvent } from './frames.js';
import { SseParser, type SseFrame } from './sseParser.js';

export interface DeliveredFrame {
    offset: number;
    frame: SseFrame;
    event: FeedEvent;
}

export interface SseClientOptions {
    baseUrl: string;
    token: string;
    logger: Logger;
    // Next offset the system still needs (durable tail + 1). Re-read on every (re)connect.
    resumeOffset: () => Promise<number>;
    // Resolve only once the frame is durably stored; a rejection drops the connection and resumes from resumeOffset().
    onFrame: (f: DeliveredFrame) => Promise<void>;
    fetchImpl?: typeof fetch;
    idleTimeoutMs?: number;
    connectTimeoutMs?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    random?: () => number;
}

export interface SseClientStats {
    connects: number;
    reconnects: number;
    delivered: number;
    duplicatesSkipped: number;
    gapsDetected: number;
    invalidFrames: number;
    lastError: string | undefined;
    lastOffset: number;
}

/**
 * Reads the satellite SSE feed. Offset is the only position that matters: frames below the expected offset are skipped,
 * a frame above it means a gap and forces a reconnect from the expected offset, so the stream handed to onFrame is
 * gap-free and duplicate-free regardless of reconnects or replayed frames.
 */
export class SatelliteSseClient {
    readonly stats: SseClientStats = {
        connects: 0,
        reconnects: 0,
        delivered: 0,
        duplicatesSkipped: 0,
        gapsDetected: 0,
        invalidFrames: 0,
        lastError: undefined,
        lastOffset: -1,
    };
    private readonly fetchImpl: typeof fetch;
    private readonly idleTimeoutMs: number;
    private readonly connectTimeoutMs: number;
    private readonly backoffBaseMs: number;
    private readonly backoffMaxMs: number;
    private readonly random: () => number;

    constructor(private readonly opts: SseClientOptions) {
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
        this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
        this.backoffBaseMs = opts.backoffBaseMs ?? 500;
        this.backoffMaxMs = opts.backoffMaxMs ?? 15_000;
        this.random = opts.random ?? Math.random;
    }

    async run(signal: AbortSignal): Promise<void> {
        let failures = 0;
        while (!signal.aborted) {
            let progressed = false;
            let retryAfterMs: number | undefined;
            try {
                const outcome = await this.connectOnce(signal);
                progressed = outcome.progressed;
                retryAfterMs = outcome.retryAfterMs;
                if (outcome.error) this.stats.lastError = outcome.error;
            } catch (err) {
                if (signal.aborted) break;
                this.stats.lastError = err instanceof Error ? err.message : String(err);
                this.opts.logger.warn({ error: this.stats.lastError }, 'satellite stream interrupted');
            }
            if (signal.aborted) break;
            failures = progressed ? 0 : failures + 1;
            this.stats.reconnects += 1;
            const ceiling = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(failures, 10));
            const delay = retryAfterMs ?? (failures === 0 ? 0 : Math.floor(this.random() * ceiling));
            await sleep(delay, signal);
        }
    }

    private async connectOnce(signal: AbortSignal): Promise<{ progressed: boolean; error?: string; retryAfterMs?: number }> {
        const from = await this.opts.resumeOffset();
        const controller = new AbortController();
        const onAbort = (): void => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        let idle: NodeJS.Timeout | undefined;
        const armIdle = (ms: number): void => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => controller.abort(new Error('idle timeout')), ms);
        };
        try {
            this.stats.connects += 1;
            armIdle(this.connectTimeoutMs);
            const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/stream?from=${from}`, {
                headers: { Authorization: `Bearer ${this.opts.token}`, Accept: 'text/event-stream' },
                signal: controller.signal,
            });
            if (res.status !== 200 || !res.body) {
                const text = await res.text().catch(() => '');
                const retryAfter = Number(res.headers.get('retry-after'));
                this.opts.logger.warn({ status: res.status, body: text.slice(0, 200) }, 'satellite stream refused');
                return {
                    progressed: false,
                    error: `HTTP ${res.status}`,
                    ...(res.status === 429 || res.status === 503 ? { retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMaxMs } : {}),
                };
            }

            const parser = new SseParser();
            const reader = res.body.getReader();
            let expected = from;
            let progressed = false;
            armIdle(this.idleTimeoutMs);
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return { progressed };
                armIdle(this.idleTimeoutMs);
                for (const frame of parser.push(value)) {
                    const event = decodeFrame(frame);
                    const offset = event.offset;
                    if (offset === undefined) {
                        this.stats.invalidFrames += 1;
                        continue;
                    }
                    if (offset < expected) {
                        this.stats.duplicatesSkipped += 1;
                        continue;
                    }
                    if (offset > expected) {
                        this.stats.gapsDetected += 1;
                        this.opts.logger.warn({ expected, received: offset }, 'offset gap on satellite stream, reconnecting');
                        await reader.cancel().catch(() => undefined);
                        return { progressed, error: 'offset gap' };
                    }
                    if (event.kind === 'invalid') this.stats.invalidFrames += 1;
                    await this.opts.onFrame({ offset, frame, event });
                    expected = offset + 1;
                    progressed = true;
                    this.stats.delivered += 1;
                    this.stats.lastOffset = offset;
                }
            }
        } finally {
            if (idle) clearTimeout(idle);
            signal.removeEventListener('abort', onAbort);
            controller.abort();
        }
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        function done(): void {
            clearTimeout(t);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}
