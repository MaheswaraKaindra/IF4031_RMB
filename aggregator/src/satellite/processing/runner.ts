import type { Logger } from 'pino';
import { fencedIngest, type ISourceFenceStore } from '../../coordination/fencing.js';
import type { LeaderLeaseHandle } from '../../coordination/leaderLoop.js';
import type { ICheckpoint } from '../../storage/contracts.js';
import type { ICanonicalRepository } from '../../storage/types.js';
import type { Fire } from '../clustering/fire.js';
import { fireHazardId, fireToHazard } from '../clustering/hazardMapping.js';
import type { IFeedLog } from '../feed/log.js';
import type { MetricsLike } from '../metrics.js';
import type { ILateStore } from './lateStore.js';
import { SatelliteProcessor, type FrameResult, type LateDetection, type ProcessorConfig } from './processor.js';
import type { ISnapshotStore } from './snapshotStore.js';

export const SATELLITE_SOURCE = 'SATELIT';
export const SATELLITE_PARTITION = 'stream';

export interface RunnerDeps {
    log: IFeedLog;
    checkpoints: ICheckpoint;
    repo: ICanonicalRepository;
    fenceStore: ISourceFenceStore;
    lateStore: ILateStore;
    cfg: ProcessorConfig;
    metrics: MetricsLike;
    logger: Logger;
    batchSize?: number;
    // Optional state snapshots (see snapshotStore.ts): a takeover loads the newest one and replays only the frames after it.
    snapshots?: ISnapshotStore;
    snapshotEveryOffsets?: number;
    snapshotEveryMs?: number;
    // Page size of the state rebuild after a restart or takeover (no side effects, so it can be much larger than a processing batch).
    rebuildPageSize?: number;
    pollMs?: number;
    writeConcurrency?: number;
    retryMs?: number;
    nowMs?: () => number;
    // Test hook: called after the canonical writes of a batch and before its checkpoint commit.
    beforeCheckpoint?: (lastOffset: number) => Promise<void> | void;
}

export class LeadershipLostError extends Error {
    constructor(detail: string) {
        super(`satellite processing lost leadership: ${detail}`);
    }
}

class TransientError extends Error {}

interface PendingUpsert {
    fire: Fire;
    version: number;
    firstReceivedMs: number;
}

/** Net effect of a batch: one operation per fire, so a fire created and removed inside one batch is never written. */
export class EffectBatch {
    readonly upserts = new Map<string, PendingUpsert>();
    readonly removals = new Set<string>();
    readonly lates: LateDetection[] = [];

    add(result: FrameResult, offset: number, receivedMs: number): void {
        for (const id of result.delta.removed) {
            this.upserts.delete(id);
            this.removals.add(id);
        }
        for (const fire of result.delta.upserts) {
            this.removals.delete(fire.fire_id);
            const prev = this.upserts.get(fire.fire_id);
            this.upserts.set(fire.fire_id, { fire, version: offset, firstReceivedMs: prev?.firstReceivedMs ?? receivedMs });
        }
        if (result.late) this.lates.push(result.late);
    }
}

/**
 * Runs only while this instance holds the SATELIT lease. State is rebuilt by replaying the durable feed log up to the
 * committed checkpoint without side effects, then frames after it are applied and their effects written. Effects are
 * idempotent (record version = offset, remove by id), so a crash between writing and checkpointing replays safely.
 */
export async function runSatelliteProcessing(deps: RunnerDeps, handle: LeaderLeaseHandle): Promise<void> {
    const batchSize = deps.batchSize ?? 500;
    const pollMs = deps.pollMs ?? 100;
    const now = deps.nowMs ?? (() => Date.now());
    const alive = (): boolean => !handle.signal.aborted && handle.isStillValid();
    let proc = new SatelliteProcessor(deps.cfg);

    try {
        const cp = await deps.checkpoints.get(SATELLITE_SOURCE, SATELLITE_PARTITION);
        let committed = cp ? Number(cp.committed_offset) : -1;
        let stateVersion = cp?.state_version ?? 0;

        // Rebuild: load the newest snapshot (state after frames 0..k, k <= committed) when there is one, then replay the log from k+1 up to the
        // checkpoint without side effects. Without a usable snapshot the whole log is replayed (1.17 million frames took 195 s on the real
        // feed with 500-frame sequential pages). The next page is read while the current one is applied.
        let replayFrom = 0;
        let snapshotOffset = -1;
        if (deps.snapshots && committed >= 0) {
            try {
                const snap = await deps.snapshots.get();
                if (snap && snap.offset >= 0 && snap.offset <= committed) {
                    proc.importState(snap.state);
                    replayFrom = snap.offset + 1;
                    snapshotOffset = snap.offset;
                }
            } catch (err) {
                deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'satellite snapshot unusable, replaying the whole feed log');
                proc = new SatelliteProcessor(deps.cfg);
                replayFrom = 0;
                snapshotOffset = -1;
            }
        }
        const rebuildPage = deps.rebuildPageSize ?? 5000;
        const startedRebuild = Date.now();
        let nextPage: Promise<Awaited<ReturnType<typeof deps.log.read>>> | undefined;
        const prefetch = (from: number): void => {
            nextPage = deps.log.read(from, rebuildPage);
            nextPage.catch(() => undefined); // a failure surfaces where the page is awaited, not as an unhandled rejection
        };
        if (replayFrom <= committed) prefetch(replayFrom);
        for (let from = replayFrom; from <= committed; ) {
            const page = await nextPage!;
            if (page.length === 0) throw new Error(`feed log ends before committed offset ${committed}`);
            const lastInPage = page[page.length - 1]!.offset;
            if (lastInPage < committed) prefetch(lastInPage + 1);
            for (const e of page) {
                if (e.offset > committed) break;
                proc.apply(e.offset, e.kind, e.raw);
            }
            from = lastInPage + 1;
        }
        let lastSnapshotOffset = snapshotOffset;
        let lastSnapshotAt = now();
        deps.logger.info({ committed_offset: committed, fires: proc.index.fires().length, epoch: handle.epoch, rebuild_ms: Date.now() - startedRebuild, snapshot_offset: snapshotOffset, replayed_frames: Math.max(0, committed - replayFrom + 1) }, 'satellite state rebuilt from feed log');

        while (alive()) {
            const entries = await deps.log.read(committed + 1, batchSize);
            if (entries.length === 0) {
                publishGauges(deps, proc, committed, committed);
                await sleep(pollMs, handle.signal);
                continue;
            }
            const batch = new EffectBatch();
            for (const e of entries) batch.add(proc.apply(e.offset, e.kind, e.raw), e.offset, Date.parse(e.received_at));
            const last = entries[entries.length - 1]!.offset;

            for (;;) {
                try {
                    await writeEffects(deps, handle, batch, now);
                    await deps.beforeCheckpoint?.(last);
                    stateVersion = await commitCheckpoint(deps, handle, last, stateVersion);
                    break;
                } catch (err) {
                    if (err instanceof LeadershipLostError) throw err;
                    if (!alive()) throw new LeadershipLostError('leadership ended while retrying a batch');
                    deps.logger.warn({ error: err instanceof Error ? err.message : String(err), last_offset: last }, 'satellite batch will be retried');
                    deps.metrics.inc('satellite_batch_retries_total', {});
                    await sleep(deps.retryMs ?? 500, handle.signal);
                }
            }
            committed = last;
            if (deps.snapshots && (committed - lastSnapshotOffset >= (deps.snapshotEveryOffsets ?? 20_000) || (committed > lastSnapshotOffset && now() - lastSnapshotAt >= (deps.snapshotEveryMs ?? 120_000)))) {
                try {
                    await deps.snapshots.put({ offset: committed, state: proc.exportState() });
                    lastSnapshotOffset = committed;
                    lastSnapshotAt = now();
                } catch (err) {
                    lastSnapshotAt = now(); // do not retry on every batch; recovery then just replays more frames
                    deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'satellite snapshot not saved');
                }
            }
            observeLatency(deps, batch, now);
            publishGauges(deps, proc, committed, await deps.log.tail());
        }
    } catch (err) {
        if (err instanceof LeadershipLostError) {
            deps.logger.warn({ reason: err.message }, 'satellite processing stopped');
            return;
        }
        throw err;
    }
}

async function writeEffects(deps: RunnerDeps, handle: LeaderLeaseHandle, batch: EffectBatch, now: () => number): Promise<void> {
    const ops: Array<() => Promise<void>> = [];
    const ingestedAt = new Date(now()).toISOString();
    for (const { fire, version } of batch.upserts.values()) {
        ops.push(async () => {
            const res = await fencedIngest(
                deps.repo,
                deps.fenceStore,
                { event: fireToHazard(fire, ingestedAt), eventVersion: version, epoch: handle.epoch },
                handle.isStillValid
            );
            if (res.outcome === 'stale_epoch') throw new LeadershipLostError(res.detail ?? 'stale epoch on write');
            if (res.outcome === 'unavailable') throw new TransientError(res.detail ?? 'store unavailable');
        });
    }
    for (const fireId of batch.removals) {
        ops.push(async () => {
            if (!handle.isStillValid() || !(await deps.fenceStore.assertEpoch(SATELLITE_SOURCE, handle.epoch))) {
                throw new LeadershipLostError('epoch superseded before remove');
            }
            const res = await deps.repo.remove(fireHazardId(fireId), handle.epoch);
            if (res.outcome === 'stale_epoch') throw new LeadershipLostError('stale epoch on remove');
            if (res.outcome === 'unavailable') throw new TransientError(res.detail ?? 'store unavailable');
        });
    }
    const width = deps.writeConcurrency ?? 16;
    for (let i = 0; i < ops.length; i += width) await Promise.all(ops.slice(i, i + width).map((op) => op()));
    await deps.lateStore.add(batch.lates);
}

async function commitCheckpoint(deps: RunnerDeps, handle: LeaderLeaseHandle, last: number, stateVersion: number): Promise<number> {
    const tail = await deps.log.tail();
    const next = {
        source: SATELLITE_SOURCE,
        partition: SATELLITE_PARTITION,
        received_offset: String(tail),
        committed_offset: String(last),
        state_version: stateVersion + 1,
        owner_epoch: handle.epoch,
    };
    const res = await deps.checkpoints.commit(next, stateVersion);
    if (res === 'applied') return next.state_version;
    if (res === 'unavailable') throw new TransientError('checkpoint store unavailable');
    if (res === 'stale_epoch') throw new LeadershipLostError('checkpoint fenced by a newer epoch');
    const cur = await deps.checkpoints.get(SATELLITE_SOURCE, SATELLITE_PARTITION);
    if (cur && cur.owner_epoch === handle.epoch && Number(cur.committed_offset) === last) return cur.state_version;
    throw new LeadershipLostError('checkpoint changed by another writer');
}

function observeLatency(deps: RunnerDeps, batch: EffectBatch, now: () => number): void {
    const t = now();
    for (const u of batch.upserts.values()) deps.metrics.observe('satellite_ingest_to_store_seconds', {}, Math.max(0, (t - u.firstReceivedMs) / 1000));
    deps.metrics.inc('satellite_fires_written_total', { op: 'upsert' }, batch.upserts.size);
    deps.metrics.inc('satellite_fires_written_total', { op: 'remove' }, batch.removals.size);
}

function publishGauges(deps: RunnerDeps, proc: SatelliteProcessor, committed: number, tail: number): void {
    const m = deps.metrics;
    m.set('satellite_committed_offset', {}, committed);
    m.set('satellite_log_tail_offset', {}, tail);
    m.set('satellite_processing_backlog', {}, Math.max(0, tail - committed));
    m.set('satellite_active_fires', {}, proc.index.fires().length);
    m.set('satellite_singleton_detections', {}, proc.index.singletonCount);
    m.set('satellite_low_confidence_detections', {}, proc.index.lowCount);
    m.set('satellite_late_detections', {}, proc.counters.lateDetections);
    m.set('satellite_ignored_retracted_detections', {}, proc.counters.ignoredRetracted);
    m.set('satellite_unknown_corrections', {}, proc.counters.unknownCorrections);
    if (Number.isFinite(proc.watermarkMs)) m.set('satellite_watermark_seconds', {}, proc.watermarkMs / 1000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
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
