import type { Logger } from 'pino';
import type { ISourceFenceStore } from '../coordination/fencing.js';
import { SourceLeaderManager } from '../coordination/leaderLoop.js';
import type { ILeaseProvider } from '../coordination/lease.js';
import { Bulkhead } from '../resilience/bulkhead.js';
import { CircuitBreaker, DEFAULT_BREAKER } from '../resilience/breaker.js';
import type { ICheckpoint } from '../storage/contracts.js';
import type { HazardRecord, ICanonicalRepository } from '../storage/types.js';
import { SensorFreshness, DEFAULT_FRESHNESS } from './freshness.js';
import type { IDeliveryLedger } from './ledger.js';
import { newSpanContext, emitSpan } from '../observability.js';
import { COASTAL_SOURCE, CoastalPoller, type CoastalMetrics, type PollTracer, type QuarantineInput } from './poller.js';
import { relayDeliveries } from './relay.js';
import { HttpSensorClient } from './sensorClient.js';

export interface CoastalEnv {
    baseUrl: string;
    token: string;
    timeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
    pageSize: number;
    breaker: typeof DEFAULT_BREAKER;
    staleLagMs: number;
    stationSilenceMs: number;
    relayIntervalMs: number;
    leaseDurationMs: number;
    renewDeadlineMs: number;
    retryPeriodMs: number;
}

export function coastalEnv(env: NodeJS.ProcessEnv): CoastalEnv | undefined {
    const token = env.PANTAI_AUTH_TOKEN;
    if (!token) return undefined;
    const num = (k: string, d: number): number => {
        const v = Number(env[k]);
        return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? v : d;
    };
    return {
        baseUrl: (env.SENSOR_PANTAI_URL || 'http://sensor-pantai:8080').replace(/\/$/, ''),
        token,
        timeoutMs: num('COASTAL_TIMEOUT_MS', 1500),
        pollIntervalMs: num('COASTAL_POLL_INTERVAL_MS', 1000),
        maxResponseBytes: num('COASTAL_MAX_RESPONSE_BYTES', 4 * 1024 * 1024),
        pageSize: num('COASTAL_PAGE_SIZE', 500),
        breaker: {
            failureThreshold: num('COASTAL_BREAKER_FAILURES', DEFAULT_BREAKER.failureThreshold),
            windowMs: num('COASTAL_BREAKER_WINDOW_MS', DEFAULT_BREAKER.windowMs),
            openMs: num('COASTAL_BREAKER_OPEN_MS', DEFAULT_BREAKER.openMs),
            maxOpenMs: num('COASTAL_BREAKER_MAX_OPEN_MS', DEFAULT_BREAKER.maxOpenMs),
            backoffFactor: DEFAULT_BREAKER.backoffFactor,
            jitter: DEFAULT_BREAKER.jitter,
            halfOpenProbes: DEFAULT_BREAKER.halfOpenProbes,
        },
        staleLagMs: num('COASTAL_STALE_LAG_SEC', DEFAULT_FRESHNESS.staleLagMs / 1000) * 1000,
        stationSilenceMs: num('COASTAL_STATION_SILENCE_SEC', DEFAULT_FRESHNESS.stationSilenceMs / 1000) * 1000,
        relayIntervalMs: num('COASTAL_RELAY_INTERVAL_MS', 500),
        // Shorter than the M1 pollers' lease: a silent leader costs critical alerts, and the fencing epoch keeps a single writer.
        leaseDurationMs: num('COASTAL_LEASE_DURATION_SEC', 8) * 1000,
        renewDeadlineMs: num('COASTAL_LEASE_RENEW_DEADLINE_SEC', 5) * 1000,
        retryPeriodMs: num('COASTAL_LEASE_RETRY_SEC', 1) * 1000,
    };
}

export interface CoastalServiceDeps {
    repo: ICanonicalRepository;
    fenceStore: ISourceFenceStore;
    checkpoints: ICheckpoint;
    ledger: IDeliveryLedger;
    leaseProvider: ILeaseProvider;
    identity: string;
    leaseDurationMs: number;
    renewDeadlineMs: number;
    retryPeriodMs: number;
    quarantine: (q: QuarantineInput) => Promise<void>;
    onCreated: (event: HazardRecord) => void;
    publishCritical: (event: HazardRecord, traceparent: string | undefined) => Promise<void>;
    markSource: (ok: boolean) => Promise<void>;
    metrics: CoastalMetrics;
    logger: Logger;
}

const tracer: PollTracer = (name, parent, attrs) => {
    const ctx = newSpanContext(parent);
    const startMs = Date.now();
    let ended = false;
    return {
        traceparent: ctx.traceparent,
        end: (ok, extra = {}) => {
            if (ended) return;
            ended = true;
            emitSpan({ traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId, name, kind: 'INTERNAL', startMs, endMs: Date.now(), ok, attributes: { ...attrs, ...extra, source: COASTAL_SOURCE } });
        },
    };
};

// Polling runs only on the COASTAL lease holder. Relaying runs on every pod: entries are claimed atomically, so a
// leadership change never leaves critical deliveries waiting for a new leader.
export class CoastalService {
    private readonly leader: SourceLeaderManager;
    private readonly client: HttpSensorClient;
    private poller: CoastalPoller | undefined;
    private pollerEpoch = -1;
    private pollTimer: NodeJS.Timeout | undefined;
    private relayTimer: NodeJS.Timeout | undefined;
    private relayBusy = false;
    private stopped = false;
    private lastGaugeAt = 0;

    constructor(private readonly cfg: CoastalEnv, private readonly deps: CoastalServiceDeps) {
        this.client = new HttpSensorClient({ baseUrl: cfg.baseUrl, token: cfg.token, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxResponseBytes });
        this.leader = new SourceLeaderManager({
            source: COASTAL_SOURCE,
            leaseName: 'aggregator-coastal',
            identity: deps.identity,
            leaseDurationMs: cfg.leaseDurationMs,
            renewDeadlineMs: cfg.renewDeadlineMs,
            retryPeriodMs: cfg.retryPeriodMs,
            leaseProvider: deps.leaseProvider,
            fenceStore: deps.fenceStore,
            logger: deps.logger,
            onLeadershipChange: ({ isLeader, epoch }) => {
                deps.metrics.set('aggregator_is_leader', { source: COASTAL_SOURCE }, isLeader ? 1 : 0);
                deps.metrics.set('aggregator_leader_epoch', { source: COASTAL_SOURCE }, epoch);
            },
        });
    }

    start(): void {
        this.leader.start();
        this.scheduleNextPoll();
        this.relayTimer = setInterval(() => void this.relayTick(), this.cfg.relayIntervalMs);
        this.relayTimer.unref();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.relayTimer) clearInterval(this.relayTimer);
        await this.leader.stop();
    }

    private scheduleNextPoll(): void {
        if (this.stopped) return;
        this.pollTimer = setTimeout(() => void this.pollTick().finally(() => this.scheduleNextPoll()), this.cfg.pollIntervalMs);
        this.pollTimer.unref();
    }

    private async pollTick(): Promise<void> {
        const { logger, metrics } = this.deps;
        try {
            const handle = await this.leader.acquirePollHandle(0);
            if (!handle) {
                this.poller = undefined;
                this.pollerEpoch = -1;
                return;
            }
            if (!this.poller || this.pollerEpoch !== handle.epoch) {
                const breaker = new CircuitBreaker({
                    ...this.cfg.breaker,
                    onTransition: (from, to, reason) => {
                        metrics.inc('coastal_breaker_transitions_total', { to });
                        logger.warn({ from, to, reason, source: COASTAL_SOURCE }, 'sensor circuit breaker transition');
                    },
                });
                let poller: CoastalPoller | undefined;
                const freshness = new SensorFreshness(
                    { ...DEFAULT_FRESHNESS, staleLagMs: this.cfg.staleLagMs, stationSilenceMs: this.cfg.stationSilenceMs },
                    () => poller?.stationIds() ?? [],
                );
                poller = new CoastalPoller({
                    client: this.client,
                    breaker,
                    bulkhead: new Bulkhead('coastal', 1),
                    freshness,
                    repo: this.deps.repo,
                    fenceStore: this.deps.fenceStore,
                    ledger: this.deps.ledger,
                    checkpoints: this.deps.checkpoints,
                    quarantine: this.deps.quarantine,
                    onCreated: this.deps.onCreated,
                    markSource: this.deps.markSource,
                    metrics,
                    tracer,
                    fastPublish: this.deps.publishCritical,
                    logger: logger.child({ source: COASTAL_SOURCE, leader_epoch: handle.epoch }),
                    cfg: { pageSize: this.cfg.pageSize },
                });
                this.poller = poller;
                this.pollerEpoch = handle.epoch;
                logger.info({ leader_epoch: handle.epoch }, 'coastal pipeline started');
            }
            await this.poller.tick(handle);
        } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'coastal poll tick failed');
        }
    }

    private async relayTick(): Promise<void> {
        if (this.relayBusy || this.stopped) return;
        this.relayBusy = true;
        try {
            await relayDeliveries(this.deps.ledger, this.deps.publishCritical, this.deps.metrics, { batch: 50, visibilityMs: 5000 }, tracer);
            if (Date.now() - this.lastGaugeAt >= 2000) {
                this.lastGaugeAt = Date.now();
                const c = await this.deps.ledger.counts();
                for (const state of ['pending', 'published', 'delivered'] as const) this.deps.metrics.set('coastal_ledger_entries', { state }, c[state]);
                this.deps.metrics.set('coastal_oldest_undelivered_seconds', {}, c.oldestUndeliveredMs / 1000);
            }
        } catch (err) {
            this.deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'coastal relay tick failed');
        } finally {
            this.relayBusy = false;
        }
    }
}
