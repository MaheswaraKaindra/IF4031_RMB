import type { Logger } from 'pino';
import type { ISourceFenceStore } from '../coordination/fencing.js';
import { fencedIngest } from '../coordination/fencing.js';
import type { LeaderLeaseHandle } from '../coordination/leaderLoop.js';
import type { Bulkhead } from '../resilience/bulkhead.js';
import type { CircuitBreaker } from '../resilience/breaker.js';
import type { ICheckpoint } from '../storage/contracts.js';
import type { HazardRecord, ICanonicalRepository } from '../storage/types.js';
import { hazardIdFor } from '../storage/identity.js';
import { contentSignature, observationToHazard, variantRef, parseUtc, validateObservation, validateStation, type Observation, type Station } from './contract.js';
import type { SensorFreshness } from './freshness.js';
import type { IDeliveryLedger } from './ledger.js';
import { SensorRequestError, type SensorClient } from './sensorClient.js';

export const COASTAL_SOURCE = 'SENSOR_PANTAI';
export const COASTAL_PARTITION = 'default';

export interface CoastalMetrics {
    inc(name: string, labels?: Record<string, string>, delta?: number): void;
    set(name: string, labels: Record<string, string>, value: number): void;
    observe(name: string, labels: Record<string, string>, value: number): void;
}

export interface QuarantineInput {
    reason: string;
    sourceRefId?: string | undefined;
    raw: Buffer;
}

export interface PollSpan {
    traceparent: string;
    end(ok: boolean, attrs?: Record<string, string | number>): void;
}

export type PollTracer = (name: string, parentTraceparent: string | undefined, attrs: Record<string, string | number>) => PollSpan;

export interface PollerConfig {
    pageSize: number;
    maxPagesPerTick: number;
    stationsTtlMs: number;
    stationsRefreshCooldownMs: number;
    blindAfterMs: number;
    blindRewindCooldownMs: number;
    conflictCacheSize: number;
    concurrency: number;
    scoutPages: number;
}

export const DEFAULT_POLLER: PollerConfig = {
    pageSize: 500,
    maxPagesPerTick: 20,
    stationsTtlMs: 60_000,
    stationsRefreshCooldownMs: 10_000,
    blindAfterMs: 120_000,
    blindRewindCooldownMs: 300_000,
    conflictCacheSize: 20_000,
    concurrency: 8,
    scoutPages: 40,
};

export interface PollerDeps {
    client: SensorClient;
    breaker: CircuitBreaker;
    bulkhead: Bulkhead;
    freshness: SensorFreshness;
    repo: ICanonicalRepository;
    fenceStore: ISourceFenceStore;
    ledger: IDeliveryLedger;
    checkpoints: ICheckpoint;
    quarantine: (q: QuarantineInput) => Promise<void>;
    onCreated: (event: HazardRecord) => void;
    markSource: (ok: boolean) => Promise<void>;
    metrics: CoastalMetrics;
    logger: Logger;
    tracer?: PollTracer;
    // Publishes a critical alert to the durable critical queue right away, without waiting for the store. Best effort: the ledger
    // and its relay remain the guarantee. The receiver deduplicates by hazard id and severity.
    fastPublish?: (event: HazardRecord, traceparent: string | undefined) => Promise<void>;
    now?: () => number;
    cfg?: Partial<PollerConfig>;
}

export type TickOutcome = 'ok' | 'skipped_breaker' | 'skipped_bulkhead' | 'request_failed' | 'contract_failed' | 'unhealthy' | 'storage_retry' | 'stale_epoch';

const SENSOR_RESET_TOLERANCE_MS = 60_000;

type Decision =
    | { kind: 'invalid'; raw: unknown; reason: string; ref: string | undefined; critical: boolean }
    | { kind: 'valid'; obs: Observation; refId: string | undefined; conflictsWith: string | undefined; critical: boolean }
    | { kind: 'skip'; critical: boolean };

class LeadershipLost extends Error {}
class StorageRetry extends Error {}

export class CoastalPoller {
    private readonly cfg: PollerConfig;
    private readonly now: () => number;
    private stations = new Map<string, Station>();
    private stationsAt = -Infinity;
    private stationsTriedAt = -Infinity;
    private cursor: string | undefined;
    private stateVersion = 0;
    private loaded = false;
    private lastGeneratedMs: number | undefined;
    private checkStore = false;
    private pollTrace: string | undefined;
    private emptySinceMs: number | undefined;
    private lastBlindRewindWall = -Infinity;
    private readonly fastSent = new Set<string>();
    private readonly signatures = new Map<string, string>();

    constructor(private readonly d: PollerDeps) {
        this.cfg = { ...DEFAULT_POLLER, ...d.cfg };
        this.now = d.now ?? Date.now;
    }

    async tick(handle: LeaderLeaseHandle): Promise<TickOutcome> {
        const release = this.d.bulkhead.tryAcquire();
        if (!release) {
            this.d.metrics.inc('coastal_poll_total', { outcome: 'skipped_bulkhead' });
            return 'skipped_bulkhead';
        }
        try {
            if (!this.d.breaker.allow()) {
                this.d.metrics.inc('coastal_poll_total', { outcome: 'skipped_breaker' });
                return 'skipped_breaker';
            }
            const t0 = performance.now();
            const span = this.d.tracer?.('poll sensor-pantai', undefined, { leader_epoch: handle.epoch, breaker: breakerLabel(this.d.breaker.state) });
            this.pollTrace = span?.traceparent;
            const outcome = await this.run(handle);
            span?.end(outcome === 'ok' || outcome === 'skipped_breaker', { outcome });
            this.d.metrics.inc('coastal_poll_total', { outcome });
            this.d.metrics.observe('coastal_poll_duration_seconds', {}, (performance.now() - t0) / 1000);
            return outcome;
        } finally {
            release();
        }
    }

    stationIds(): string[] {
        return [...this.stations.keys()];
    }

    private async run(handle: LeaderLeaseHandle): Promise<TickOutcome> {
        const { breaker, metrics, logger } = this.d;
        try {
            if (!this.loaded) await this.loadCheckpoint();
            if (this.now() - this.stationsAt > this.cfg.stationsTtlMs) await this.refreshStations();

            let lastHealth: 'fresh' | 'stale' | 'frozen_clock' | 'unknown' = 'fresh';
            for (let page = 0; page < this.cfg.maxPagesPerTick; page++) {
                if (!handle.isStillValid()) throw new LeadershipLost('local leadership expired');
                const body = await this.request('observations', () => this.d.client.observations({ cursor: this.cursor, limit: this.cfg.pageSize }));
                const parsed = parseResponse(body);
                if (!parsed.ok) {
                    await this.quarantineOrThrow({ reason: `response_contract:${parsed.reason}`, raw: Buffer.from(JSON.stringify(body)) });
                    metrics.inc('coastal_observations_total', { outcome: 'quarantined' });
                    breaker.onFailure('response_contract');
                    return 'contract_failed';
                }
                if (this.lastGeneratedMs !== undefined && parsed.generatedMs < this.lastGeneratedMs - SENSOR_RESET_TOLERANCE_MS) {
                    await this.rewind(parsed.generatedMs, handle);
                    continue;
                }
                this.lastGeneratedMs = parsed.generatedMs;
                if (await this.blindCheck(parsed.items.length, parsed.generatedMs, handle)) continue;
                if (page === 0 && parsed.items.length >= this.cfg.pageSize && parsed.nextCursor) await this.scout(parsed.nextCursor, handle);
                await this.processPage(parsed.items, parsed.generatedMs, handle);
                if (parsed.nextCursor) await this.commitCursor(parsed.nextCursor, handle, parsed.generatedMs);
                const tail = parsed.items.length < this.cfg.pageSize;
                const report = this.d.freshness.evaluate(parsed.generatedMs, tail, this.now());
                lastHealth = report.health;
                if (report.lagMs !== null) metrics.set('coastal_sensor_lag_seconds', {}, report.lagMs / 1000);
                metrics.set('coastal_silent_stations', {}, report.silentStations.length);
                if (tail) this.checkStore = false;
                if (tail || report.health === 'frozen_clock') break;
            }
            for (const h of ['fresh', 'stale', 'frozen_clock', 'unknown'] as const) metrics.set('coastal_sensor_health', { state: h }, h === lastHealth ? 1 : 0);
            if (lastHealth === 'stale' || lastHealth === 'frozen_clock') {
                breaker.onFailure(lastHealth);
                await this.d.markSource(false).catch(() => undefined);
                return 'unhealthy';
            }
            breaker.onSuccess();
            await this.d.markSource(true).catch(() => undefined);
            return 'ok';
        } catch (err) {
            if (err instanceof LeadershipLost) return 'stale_epoch';
            if (err instanceof StorageRetry) {
                breaker.onSuccess();
                return 'storage_retry';
            }
            if (err instanceof SensorRequestError) {
                logger.warn({ kind: err.kind, status: err.status, breaker: breaker.state }, 'sensor request failed');
                breaker.onFailure(err.kind === 'http' ? `http_${err.status}` : err.kind);
                await this.d.markSource(false).catch(() => undefined);
                return 'request_failed';
            }
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'coastal poll failed');
            breaker.onFailure('internal');
            return 'request_failed';
        } finally {
            this.d.metrics.set('coastal_breaker_state', {}, { closed: 0, half_open: 1, open: 2 }[breaker.state]);
        }
    }

    // Holding a cursor but seeing no observation at all for a long stretch of sensor time means the cursor may point past the end of a
    // log that was replaced or restarted without its clock going backwards. Read from the start once: duplicates are idempotent.
    private async blindCheck(itemCount: number, generatedMs: number, handle: LeaderLeaseHandle): Promise<boolean> {
        if (itemCount > 0 || this.cursor === undefined) {
            this.emptySinceMs = undefined;
            return false;
        }
        this.emptySinceMs ??= generatedMs;
        if (generatedMs - this.emptySinceMs < this.cfg.blindAfterMs || this.now() - this.lastBlindRewindWall < this.cfg.blindRewindCooldownMs) return false;
        this.lastBlindRewindWall = this.now();
        this.emptySinceMs = undefined;
        this.d.logger.warn({ idle_sensor_seconds: Math.round(this.cfg.blindAfterMs / 1000) }, 'no observation for a long stretch of sensor time while holding a cursor, reading from the start');
        this.d.metrics.inc('coastal_blind_rewinds_total');
        await this.rewind(generatedMs, handle);
        return true;
    }

    // The sensor's clock went backwards: it restarted and its log starts over, so our cursor points past its end. Read from
    // the beginning again. Identical observations are idempotent, and reused ids with different content are kept apart.
    private async rewind(generatedMs: number, handle: LeaderLeaseHandle): Promise<void> {
        this.d.logger.warn({ previous_generated_at: new Date(this.lastGeneratedMs!).toISOString(), generated_at: new Date(generatedMs).toISOString() }, 'sensor clock went backwards, restarting from the beginning of its log');
        this.d.metrics.inc('coastal_sensor_resets_total');
        this.signatures.clear();
        this.d.freshness.reset();
        this.checkStore = true;
        await this.commitCursor('', handle, generatedMs);
        this.cursor = undefined;
        this.lastGeneratedMs = generatedMs;
    }

    private async request<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
        try {
            const out = await fn();
            this.d.metrics.inc('coastal_sensor_requests_total', { endpoint, outcome: 'ok' });
            return out;
        } catch (err) {
            this.d.metrics.inc('coastal_sensor_requests_total', { endpoint, outcome: err instanceof SensorRequestError ? err.kind : 'error' });
            throw err;
        }
    }

    private async loadCheckpoint(): Promise<void> {
        const cp = await this.d.checkpoints.get(COASTAL_SOURCE, COASTAL_PARTITION).catch(() => {
            throw new StorageRetry('checkpoint unavailable');
        });
        this.cursor = cp?.committed_offset || undefined;
        const g = Number(cp?.received_offset);
        if (cp && Number.isFinite(g) && g > 0) this.lastGeneratedMs = g;
        this.stateVersion = cp?.state_version ?? 0;
        this.loaded = true;
    }

    private async refreshStations(): Promise<void> {
        this.stationsTriedAt = this.now();
        const body = await this.request('stations', () => this.d.client.stations());
        const items = (body as { items?: unknown })?.items;
        if (!Array.isArray(items)) throw new SensorRequestError('not_json', 'stations response has no items array');
        const next = new Map<string, Station>();
        for (const raw of items) {
            const s = validateStation(raw);
            if (s) next.set(s.station_id, s);
            else this.d.metrics.inc('coastal_stations_invalid_total');
        }
        if (next.size === 0) throw new SensorRequestError('not_json', 'stations response has no valid station');
        this.stations = next;
        this.stationsAt = this.now();
    }

    private async processPage(items: unknown[], generatedMs: number, handle: LeaderLeaseHandle): Promise<void> {
        // Decisions follow the order of the sensor's log, so which copy of a reused id is "the original" never depends on
        // the order of execution.
        const decisions = await this.classify(items, generatedMs);
        await this.fastPublishAll(decisions);
        // Critical-flagged observations go first so their delivery does not wait behind a burst of ordinary ones.
        const lanes = [decisions.filter((d) => d.critical), decisions.filter((d) => !d.critical)];
        for (const lane of lanes) {
            for (let i = 0; i < lane.length; i += this.cfg.concurrency) {
                if (!handle.isStillValid()) throw new LeadershipLost('local leadership expired');
                const results = await Promise.allSettled(lane.slice(i, i + this.cfg.concurrency).map((d) => this.execute(d, handle)));
                let failure: unknown;
                for (const r of results) {
                    if (r.status === 'fulfilled') this.d.metrics.inc('coastal_observations_total', { outcome: r.value });
                    else if (failure === undefined || r.reason instanceof LeadershipLost) failure = r.reason;
                }
                if (failure !== undefined) throw failure;
            }
        }
    }

    // A full first page means a backlog or a burst. Ordinary observations are drained page by page, which can take a long time,
    // so a critical observation sitting deep in the backlog would wait for all of them. Scout the pages behind the current one
    // and deliver only the critical ones now. Each page is read at most twice, and only when there is a backlog.
    private async scout(from: string, handle: LeaderLeaseHandle): Promise<void> {
        const collected: { raw: unknown; generatedMs: number }[] = [];
        let cursor = from;
        for (let i = 0; i < this.cfg.scoutPages; i++) {
            if (!handle.isStillValid()) throw new LeadershipLost('local leadership expired');
            const body = await this.request('observations_scout', () => this.d.client.observations({ cursor, limit: this.cfg.pageSize }));
            const parsed = parseResponse(body);
            if (!parsed.ok) break;
            for (const raw of parsed.items) if ((raw as { critical?: unknown } | null)?.critical === true) collected.push({ raw, generatedMs: parsed.generatedMs });
            if (parsed.items.length < this.cfg.pageSize || !parsed.nextCursor) break;
            cursor = parsed.nextCursor;
        }
        if (collected.length === 0) return;
        const decisions = (await this.classify(collected.map((c) => c.raw), collected[collected.length - 1]!.generatedMs)).filter((d) => d.kind === 'valid');
        await this.fastPublishAll(decisions);
        for (let j = 0; j < decisions.length; j += this.cfg.concurrency) {
            const results = await Promise.allSettled(decisions.slice(j, j + this.cfg.concurrency).map((d) => this.execute(d, handle)));
            for (const r of results) {
                if (r.status === 'fulfilled') this.d.metrics.inc('coastal_observations_total', { outcome: `scouted_${r.value}` });
                else throw r.reason;
            }
        }
    }

    private async classify(items: unknown[], generatedMs: number): Promise<Decision[]> {
        const seen = new Set<string>();
        const out: Decision[] = [];
        for (const raw of items) {
            let v = validateObservation(raw, this.stations, generatedMs);
            if (!v.ok && v.reason === 'unknown_station' && this.now() - this.stationsTriedAt > this.cfg.stationsRefreshCooldownMs) {
                await this.refreshStations().catch(() => undefined);
                v = validateObservation(raw, this.stations, generatedMs);
            }
            if (!v.ok) {
                const ref = (raw as { observation_id?: unknown } | null)?.observation_id;
                out.push({ kind: 'invalid', raw, reason: v.reason, ref: typeof ref === 'string' ? ref : undefined, critical: (raw as { critical?: unknown } | null)?.critical === true });
                continue;
            }
            const obs = v.observation;
            this.d.freshness.recordObservation(obs.station_id, obs.observed_ms);
            const sig = contentSignature(obs);
            const known = this.signatures.get(obs.observation_id);
            let refId: string | undefined;
            let conflictsWith: string | undefined;
            if (known !== undefined && known !== sig) {
                refId = variantRef(obs);
                conflictsWith = obs.observation_id;
            } else if (known === undefined) {
                if (this.checkStore) {
                    const stored = await this.d.repo.getById(hazardIdFor('SENSOR_PANTAI', obs.observation_id)).catch(() => {
                        throw new StorageRetry('store unavailable');
                    });
                    if (stored && !sameContent(stored, obs)) {
                        refId = variantRef(obs);
                        conflictsWith = obs.observation_id;
                    }
                }
                if (refId === undefined) this.remember(obs.observation_id, sig);
            }
            const key = refId ?? obs.observation_id;
            if (seen.has(key)) {
                out.push({ kind: 'skip', critical: false });
                continue;
            }
            seen.add(key);
            out.push({ kind: 'valid', obs, refId, conflictsWith, critical: obs.critical });
        }
        return out;
    }

    private async execute(d: Decision, handle: LeaderLeaseHandle): Promise<string> {
        if (d.kind === 'skip') return 'duplicate_in_page';
        if (d.kind === 'invalid') {
            await this.quarantineOrThrow({ reason: d.reason, sourceRefId: d.ref, raw: Buffer.from(JSON.stringify(d.raw)) });
            this.d.metrics.inc('coastal_quarantine_total', { reason: d.reason.split(':')[0]! });
            if (d.critical) {
                // Flagged critical by the sensor but not a valid observation: it cannot become a HazardEvent, so make it loud.
                this.d.metrics.inc('coastal_quarantined_critical_total', { reason: d.reason.split(':')[0]! });
                this.d.logger.error({ reason: d.reason, observation_id: d.ref }, 'critical-flagged observation violates the contract and was quarantined, needs operator attention');
            }
            return 'quarantined';
        }
        if (d.conflictsWith !== undefined) this.d.metrics.inc('coastal_id_reuse_total');
        return this.store(d.obs, handle, d.refId, d.conflictsWith);
    }

    private async store(obs: Observation, handle: LeaderLeaseHandle, sourceRefId?: string, conflictsWith?: string): Promise<string> {
        const station = this.stations.get(obs.station_id)!;
        const record = observationToHazard(obs, station, { ingestedAt: new Date(this.now()).toISOString(), sourceRefId, conflictsWith });
        let deliveryId: string | undefined;
        const span = obs.critical ? this.d.tracer?.('coastal critical ingest', this.pollTrace, { hazard_id: record.hazard_id, observation_id: obs.observation_id, station_id: obs.station_id }) : undefined;
        if (obs.critical) await this.fastPublish(record, span?.traceparent);
        if (obs.critical) {
            try {
                deliveryId = (await this.d.ledger.register(record, span?.traceparent)).id;
            } catch {
                throw new StorageRetry('ledger unavailable');
            }
        }
        const res = await fencedIngest(this.d.repo, this.d.fenceStore, { event: record, epoch: handle.epoch }, handle.isStillValid);
        if (res.outcome === 'stale_epoch') throw new LeadershipLost('fenced by a newer epoch');
        if (res.outcome === 'unavailable' || res.outcome === 'stale_version') throw new StorageRetry(res.detail ?? 'storage unavailable');
        if (deliveryId) {
            try {
                await this.d.ledger.markCanonicalApplied(deliveryId);
            } catch {
                span?.end(false);
                throw new StorageRetry('ledger unavailable');
            }
            span?.end(true);
            this.d.logger.warn({ hazard_id: record.hazard_id, observation_id: obs.observation_id, station_id: obs.station_id, area_name: record.area_name }, 'critical coastal observation accepted for delivery');
        }
        if (res.created) {
            this.d.onCreated(record);
            return obs.critical ? 'stored_critical' : 'stored';
        }
        return 'duplicate';
    }

    // Every critical alert of a page goes out at once, before any store work, so a backlog is not drained one write at a time.
    private async fastPublishAll(decisions: Decision[]): Promise<void> {
        if (!this.d.fastPublish) return;
        const todo = decisions.filter((d): d is Extract<Decision, { kind: 'valid' }> => d.kind === 'valid' && d.critical);
        for (let i = 0; i < todo.length; i += 50) {
            await Promise.all(
                todo.slice(i, i + 50).map((d) => {
                    const station = this.stations.get(d.obs.station_id);
                    if (!station) return Promise.resolve();
                    const record = observationToHazard(d.obs, station, { ingestedAt: new Date(this.now()).toISOString(), sourceRefId: d.refId, conflictsWith: d.conflictsWith });
                    return this.fastPublish(record, undefined);
                }),
            );
        }
    }

    private async fastPublish(record: HazardRecord, traceparent: string | undefined): Promise<void> {
        if (!this.d.fastPublish || this.fastSent.has(record.hazard_id)) return;
        if (this.fastSent.size >= this.cfg.conflictCacheSize) this.fastSent.delete(this.fastSent.values().next().value!);
        this.fastSent.add(record.hazard_id);
        try {
            await Promise.race([
                this.d.fastPublish(record, traceparent),
                new Promise<never>((_, reject) => setTimeout(reject, 1000, new Error('fast publish timeout')).unref()),
            ]);
            this.d.metrics.inc('coastal_fast_publish_total', { outcome: 'ok' });
        } catch {
            this.fastSent.delete(record.hazard_id);
            this.d.metrics.inc('coastal_fast_publish_total', { outcome: 'failed' });
        }
    }

    private remember(id: string, sig: string): void {
        if (this.signatures.size >= this.cfg.conflictCacheSize) this.signatures.delete(this.signatures.keys().next().value!);
        this.signatures.set(id, sig);
    }

    private async quarantineOrThrow(q: QuarantineInput): Promise<void> {
        try {
            await this.d.quarantine(q);
        } catch {
            throw new StorageRetry('quarantine unavailable');
        }
    }

    // received_offset carries the sensor's generated_at (ms) of the page, so a new leader can still tell that the sensor clock went backwards.
    private async commitCursor(next: string, handle: LeaderLeaseHandle, generatedMs: number): Promise<void> {
        const res = await this.d.checkpoints
            .commit(
                {
                    source: COASTAL_SOURCE,
                    partition: COASTAL_PARTITION,
                    received_offset: String(generatedMs),
                    committed_offset: next,
                    state_version: this.stateVersion + 1,
                    owner_epoch: handle.epoch,
                },
                this.stateVersion,
            )
            .catch(() => 'unavailable' as const);
        if (res === 'applied') {
            this.stateVersion++;
            this.cursor = next;
            return;
        }
        if (res === 'stale_epoch') throw new LeadershipLost('checkpoint fenced');
        // An unavailable store is not a reason to stop asking the sensor: keep the position in memory and retry the commit later.
        // Only a version conflict (a lost reply that did apply, or another writer) needs the stored checkpoint again.
        if (res === 'conflict') {
            const cp = await this.d.checkpoints.get(COASTAL_SOURCE, COASTAL_PARTITION).catch(() => null);
            if (cp) {
                this.stateVersion = cp.state_version;
                if (cp.committed_offset === next && cp.owner_epoch === handle.epoch) {
                    this.cursor = next;
                    return;
                }
            }
        }
        throw new StorageRetry(`checkpoint ${res}`);
    }
}

type Parsed = { ok: true; items: unknown[]; generatedMs: number; nextCursor: string | null } | { ok: false; reason: string };

function parseResponse(body: unknown): Parsed {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'not_an_object' };
    const b = body as { items?: unknown; generated_at?: unknown; next_cursor?: unknown };
    if (!Array.isArray(b.items)) return { ok: false, reason: 'items_not_array' };
    const generatedMs = parseUtc(b.generated_at);
    if (generatedMs === null) return { ok: false, reason: 'bad_generated_at' };
    if (b.next_cursor !== null && b.next_cursor !== undefined && typeof b.next_cursor !== 'string') return { ok: false, reason: 'bad_next_cursor' };
    return { ok: true, items: b.items, generatedMs, nextCursor: typeof b.next_cursor === 'string' && b.next_cursor !== '' ? b.next_cursor : null };
}

function sameContent(stored: HazardRecord, obs: Observation): boolean {
    const a = stored.attributes;
    return (
        stored.occurred_at === new Date(obs.observed_ms).toISOString() &&
        a['station_id'] === obs.station_id &&
        a['sea_level_anomaly_m'] === obs.sea_level_anomaly_m &&
        a['wave_height_m'] === obs.wave_height_m &&
        a['quality'] === obs.quality &&
        a['critical'] === obs.critical
    );
}

function breakerLabel(state: string): string {
    return state;
}
