import type { Logger } from 'pino';
import type { Db } from 'mongodb';
import type { ISourceFenceStore } from '../coordination/fencing.js';
import { SourceLeaderManager } from '../coordination/leaderLoop.js';
import type { ILeaseProvider } from '../coordination/lease.js';
import type { ICheckpoint } from '../storage/contracts.js';
import type { ICanonicalRepository } from '../storage/types.js';
import { createFeedIngestor } from './feed/ingestor.js';
import { MongoFeedLog } from './feed/log.js';
import { MongoLateStore } from './processing/lateStore.js';
import { runSessionMonitor } from './feed/sessionMonitor.js';
import type { MetricsLike } from './metrics.js';
import { runSatelliteProcessing, SATELLITE_SOURCE } from './processing/runner.js';
import { MongoSnapshotStore } from './processing/snapshotStore.js';

export interface SatelliteServiceDeps {
    repo: ICanonicalRepository;
    fenceStore: ISourceFenceStore;
    checkpoints: ICheckpoint;
    getDb: () => Db;
    leaseProvider: ILeaseProvider;
    identity: string;
    leaseDurationMs: number;
    renewDeadlineMs: number;
    retryPeriodMs: number;
    metrics: MetricsLike;
    logger: Logger;
}

export interface SatelliteEnv {
    baseUrl: string;
    token: string;
    latenessMs: number;
    evictEveryOffsets: number;
    batchSize: number;
}

export function satelliteEnv(env: NodeJS.ProcessEnv): SatelliteEnv | undefined {
    const token = env.SATELLITE_GROUP_TOKEN;
    if (!token) return undefined;
    return {
        baseUrl: env.SATELLITE_BASE_URL || 'https://satellite.naufarrel.dev',
        token,
        latenessMs: Number(env.SATELLITE_LATENESS_MINUTES || 360) * 60_000,
        evictEveryOffsets: Number(env.SATELLITE_EVICT_EVERY || 1000),
        batchSize: Number(env.SATELLITE_BATCH_SIZE || 500),
    };
}

/** Ingestion and processing both run only on the instance holding the SATELIT lease; a failover resumes from the durable log and checkpoint. */
const SATELLITE_GAUGES = [
    'satellite_source_latest_offset', 'satellite_source_offset_lag', 'satellite_committed_offset', 'satellite_log_tail_offset', 'satellite_processing_backlog',
    'satellite_active_fires', 'satellite_singleton_detections', 'satellite_low_confidence_detections', 'satellite_late_detections',
    'satellite_ignored_retracted_detections', 'satellite_unknown_corrections', 'satellite_virtual_now_seconds', 'satellite_watermark_seconds', 'satellite_feed_speed',
] as const;

export class SatelliteService {
    private readonly leader: SourceLeaderManager;
    private timer: NodeJS.Timeout | undefined;
    private running = false;

    constructor(private readonly cfg: SatelliteEnv, private readonly deps: SatelliteServiceDeps) {
        this.leader = new SourceLeaderManager({
            source: SATELLITE_SOURCE,
            leaseName: 'aggregator-satellite',
            identity: deps.identity,
            leaseDurationMs: deps.leaseDurationMs,
            renewDeadlineMs: deps.renewDeadlineMs,
            retryPeriodMs: deps.retryPeriodMs,
            leaseProvider: deps.leaseProvider,
            fenceStore: deps.fenceStore,
            logger: deps.logger,
            onLeadershipChange: ({ isLeader, epoch }) => {
                deps.metrics.set('aggregator_is_leader', { source: SATELLITE_SOURCE }, isLeader ? 1 : 0);
                deps.metrics.set('aggregator_leader_epoch', { source: SATELLITE_SOURCE }, epoch);
            },
        });
    }

    start(): void {
        this.leader.start();
        this.timer = setInterval(() => void this.tick(), 2000);
        this.timer.unref();
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        await this.leader.stop();
    }

    private async tick(): Promise<void> {
        if (this.running) return;
        const handle = await this.leader.acquirePollHandle(0);
        if (!handle) return;
        this.running = true;
        const { deps, cfg } = this;
        const log = new MongoFeedLog(deps.getDb);
        const logger = deps.logger.child({ source: SATELLITE_SOURCE, leader_epoch: handle.epoch });
        logger.info('satellite pipeline started');
        const ingestor = createFeedIngestor({ baseUrl: cfg.baseUrl, token: cfg.token, logger, log });
        void Promise.allSettled([
            ingestor.run(handle.signal),
            runSessionMonitor({ baseUrl: cfg.baseUrl, token: cfg.token, log, metrics: deps.metrics, logger }, handle.signal),
            runSatelliteProcessing(
                {
                    log,
                    checkpoints: deps.checkpoints,
                    repo: deps.repo,
                    fenceStore: deps.fenceStore,
                    lateStore: new MongoLateStore(deps.getDb),
                    snapshots: new MongoSnapshotStore(deps.getDb),
                    cfg: { lateness_ms: cfg.latenessMs, evict_every_offsets: cfg.evictEveryOffsets },
                    metrics: deps.metrics,
                    logger,
                    batchSize: cfg.batchSize,
                },
                handle
            ),
        ]).then((results) => {
            for (const r of results) if (r.status === 'rejected') logger.error({ error: String(r.reason) }, 'satellite pipeline task failed');
            logger.info('satellite pipeline stopped');
            // A pod that is no longer the leader must not keep reporting the last feed state: dashboards take the max over pods and would show a stale lag.
            for (const g of SATELLITE_GAUGES) deps.metrics.set(g, {}, Number.NaN);
            this.running = false;
        });
    }
}
