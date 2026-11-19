// P4 measurement tool. Runs the real satellite pipeline (feed, Mongo feed log, processor, canonical repository) outside the
// leader election, against a throwaway database, and reports lag and latency.
//   node --import tsx src/tools/satellite-tool.ts run    [--seconds 120] [--db p4_bench] [--reset] [--lateness 360]
//   node --import tsx src/tools/satellite-tool.ts export [--db p4_bench] [--out fires.json]
//   node --import tsx src/tools/satellite-tool.ts report [--db p4_bench]
//   node --import tsx src/tools/satellite-tool.ts failover [--db p4_failover] [--seconds 40]   two instances share the SATELIT lease; the leader is stopped midway
//   node --import tsx src/tools/satellite-tool.ts verify [--db p4_bench] [--lateness 360]   compare Mongo with an independent replay of the feed log
// Env: MONGO_URI (default mongodb://127.0.0.1:27018), SATELLITE_BASE_URL, SATELLITE_GROUP_TOKEN.
import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import { MongoCheckpointStore } from '../coordination/checkpoints.js';
import { MongoSourceFenceStore } from '../coordination/fencing.js';
import { MongoLeaseProvider } from '../coordination/lease.js';
import { SatelliteService } from '../satellite/service.js';
import { MongoCanonicalRepository } from '../storage/mongoRepository.js';
import type { HazardRecord } from '../storage/types.js';
import { createFeedIngestor } from '../satellite/feed/ingestor.js';
import { MongoFeedLog } from '../satellite/feed/log.js';
import { MongoLateStore } from '../satellite/processing/lateStore.js';
import { fireToHazard } from '../satellite/clustering/hazardMapping.js';
import { SatelliteProcessor } from '../satellite/processing/processor.js';
import type { MetricsLike } from '../satellite/metrics.js';
import { runSatelliteProcessing, SATELLITE_PARTITION, SATELLITE_SOURCE } from '../satellite/processing/runner.js';

function flag(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    return next === undefined || next.startsWith('--') ? 'true' : next;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

class Collector implements MetricsLike {
    readonly latencies: number[] = [];
    readonly gauges = new Map<string, number>();
    readonly counters = new Map<string, number>();
    inc(name: string, labels: Record<string, string> = {}, delta = 1): void {
        const k = `${name}${JSON.stringify(labels)}`;
        this.counters.set(k, (this.counters.get(k) ?? 0) + delta);
    }
    set(name: string, _labels: Record<string, string>, value: number): void {
        this.gauges.set(name, value);
    }
    observe(name: string, _labels: Record<string, string>, value: number): void {
        if (name === 'satellite_ingest_to_store_seconds') this.latencies.push(value);
    }
}

async function main(): Promise<void> {
    const cmd = process.argv[2];
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018';
    const dbName = flag('db', 'p4_bench')!;
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    const repo = new MongoCanonicalRepository({ client, dbName, strictWrites: true });
    try {
        if (cmd === 'run') await run(client, repo, dbName);
        else if (cmd === 'export') await exportFires(repo);
        else if (cmd === 'report') await report(repo, db);
        else if (cmd === 'verify') await verify(repo, db);
        else if (cmd === 'failover') await failover(client, repo, dbName);
        else console.error('usage: run | export | report');
    } finally {
        await repo.close().catch(() => undefined);
        await client.close();
    }
}

async function run(client: MongoClient, repo: MongoCanonicalRepository, dbName: string): Promise<void> {
    const token = process.env.SATELLITE_GROUP_TOKEN;
    if (!token) throw new Error('SATELLITE_GROUP_TOKEN is not set');
    const baseUrl = process.env.SATELLITE_BASE_URL || 'https://satellite.naufarrel.dev';
    const seconds = Number(flag('seconds', '120'));
    const db = client.db(dbName);
    if (flag('reset')) await db.dropDatabase();
    const getDb = () => db;
    const log = new MongoFeedLog(getDb);
    const fence = new MongoSourceFenceStore(getDb);
    const checkpoints = new MongoCheckpointStore(getDb);
    const metrics = new Collector();
    const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

    const epoch = await fence.activateEpoch(SATELLITE_SOURCE, 'satellite-tool');
    const ac = new AbortController();
    const handle = { epoch, signal: ac.signal, isStillValid: () => !ac.signal.aborted };
    const ingestor = createFeedIngestor({ baseUrl, token, logger, log });
    const processing = runSatelliteProcessing(
        {
            log, checkpoints, repo, fenceStore: fence, lateStore: new MongoLateStore(getDb), metrics, logger,
            cfg: { lateness_ms: Number(flag('lateness', '360')) * 60_000, evict_every_offsets: Number(flag('evict', '1000')) },
            batchSize: Number(flag('batch', '500')),
        },
        handle
    );
    const ingesting = ingestor.run(ac.signal);

    const started = Date.now();
    const sessionHeaders = { Authorization: `Bearer ${token}` };
    let peakBacklog = 0;
    let peakSourceLag = 0;
    let lastCaughtUp: number | undefined;
    const sampler = setInterval(() => {
        void (async () => {
            const session = (await fetch(`${baseUrl}/v1/session`, { headers: sessionHeaders }).then((r) => r.json()).catch(() => undefined)) as { latest_offset?: number } | undefined;
            const tail = await log.tail();
            const committed = metrics.gauges.get('satellite_committed_offset') ?? -1;
            const backlog = Math.max(0, tail - committed);
            const sourceLag = session?.latest_offset !== undefined ? Math.max(0, session.latest_offset - tail) : NaN;
            peakBacklog = Math.max(peakBacklog, backlog);
            if (Number.isFinite(sourceLag)) peakSourceLag = Math.max(peakSourceLag, sourceLag);
            if (backlog <= 5 && sourceLag <= 5) lastCaughtUp = Date.now();
            const sorted = [...metrics.latencies].sort((a, b) => a - b);
            console.log(
                JSON.stringify({
                    t: Math.round((Date.now() - started) / 1000),
                    source_offset: session?.latest_offset, tail, committed, source_lag: sourceLag, backlog,
                    fires: metrics.gauges.get('satellite_active_fires'), singletons: metrics.gauges.get('satellite_singleton_detections'),
                    late: metrics.gauges.get('satellite_late_detections'), p95_s: Number(percentile(sorted, 0.95).toFixed(3)),
                })
            );
        })();
    }, 5000);

    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(sampler);
    ac.abort();
    await Promise.allSettled([processing, ingesting]);
    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    const cp = await checkpoints.get(SATELLITE_SOURCE, SATELLITE_PARTITION);
    console.log(
        JSON.stringify(
            {
                summary: {
                    seconds, frames_delivered: ingestor.stats.delivered, reconnects: ingestor.stats.reconnects, gaps: ingestor.stats.gapsDetected,
                    committed_offset: cp?.committed_offset, tail: await log.tail(),
                    p50_s: percentile(sorted, 0.5), p95_s: percentile(sorted, 0.95), p99_s: percentile(sorted, 0.99), samples: sorted.length,
                    peak_backlog: peakBacklog, peak_source_lag: peakSourceLag,
                    seconds_since_last_caught_up: lastCaughtUp ? Math.round((Date.now() - lastCaughtUp) / 1000) : null,
                },
            },
            null,
            2
        )
    );
}

async function allFires(repo: MongoCanonicalRepository): Promise<HazardRecord[]> {
    const out: HazardRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
        const page = await repo.queryGlobal({ sort: 'ingested_asc', limit: 1000, cursor, filter: { source: 'SATELIT' } });
        out.push(...page.items);
        if (!page.next_cursor) return out;
        cursor = page.next_cursor;
    }
}

async function exportFires(repo: MongoCanonicalRepository): Promise<void> {
    const fires = (await allFires(repo)).sort((a, b) => (a.source_ref_id < b.source_ref_id ? -1 : 1));
    const text = JSON.stringify(fires, null, 2);
    const out = flag('out');
    if (out) writeFileSync(out, text);
    else console.log(text);
    console.error(`${fires.length} fires exported`);
}

async function failover(client: MongoClient, repo: MongoCanonicalRepository, dbName: string): Promise<void> {
    const token = process.env.SATELLITE_GROUP_TOKEN;
    if (!token) throw new Error('SATELLITE_GROUP_TOKEN is not set');
    const db = client.db(dbName);
    await db.dropDatabase();
    const getDb = () => db;
    const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
    const seconds = Number(flag('seconds', '40'));
    const make = (id: string) => {
        const metrics = new Collector();
        const svc = new SatelliteService(
            { baseUrl: process.env.SATELLITE_BASE_URL || 'https://satellite.naufarrel.dev', token, latenessMs: 360 * 60_000, evictEveryOffsets: 1000, batchSize: 500 },
            {
                repo, fenceStore: new MongoSourceFenceStore(getDb), checkpoints: new MongoCheckpointStore(getDb), getDb,
                leaseProvider: new MongoLeaseProvider(getDb), identity: id, leaseDurationMs: 6000, renewDeadlineMs: 4000, retryPeriodMs: 1000, metrics, logger,
            }
        );
        return { id, metrics, svc };
    };
    const nodes = [make('pod-a'), make('pod-b')];
    const t0 = Date.now();
    const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    const leaderOf = () => nodes.find((n) => n.metrics.gauges.get('aggregator_is_leader') === 1);
    const committedOf = (n: (typeof nodes)[number]) => n.metrics.gauges.get('satellite_committed_offset') ?? -1;
    for (const n of nodes) n.svc.start();

    await new Promise((r) => setTimeout(r, (seconds / 2) * 1000));
    const first = leaderOf();
    if (!first) throw new Error('no leader elected');
    const other = nodes.find((n) => n !== first)!;
    console.log(`${at()} leader=${first.id} committed=${committedOf(first)}; stopping it`);
    const stoppedAt = Date.now();
    await first.svc.stop();
    first.metrics.gauges.set('aggregator_is_leader', 0);
    while (leaderOf() !== other && Date.now() - stoppedAt < 60_000) await new Promise((r) => setTimeout(r, 200));
    const tookOverMs = Date.now() - stoppedAt;
    console.log(`${at()} leader=${leaderOf()?.id ?? 'none'} after ${tookOverMs} ms`);

    await new Promise((r) => setTimeout(r, (seconds / 2) * 1000));
    console.log(`${at()} ${other.id} committed=${committedOf(other)}`);
    await other.svc.stop();
    const cp = await new MongoCheckpointStore(getDb).get(SATELLITE_SOURCE, SATELLITE_PARTITION);
    console.log(JSON.stringify({ failover: { first_leader: first.id, takeover_ms: tookOverMs, new_leader: other.id, new_leader_progressed: committedOf(other) > committedOf(first), final_committed: cp?.committed_offset, final_epoch: cp?.owner_epoch } }, null, 2));
}

function stable(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v !== null && typeof v === 'object') {
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
}

async function verify(repo: MongoCanonicalRepository, db: import('mongodb').Db): Promise<void> {
    // Order matters on a live system: checkpoint first, then the store, then the log tail. The store can then only be ahead of the
    // checkpoint (effects precede it) and never ahead of the tail, so fires touched by frames in (checkpoint, tail] are in flight.
    const cp = await new MongoCheckpointStore(() => db).get(SATELLITE_SOURCE, SATELLITE_PARTITION);
    const committed = cp ? Number(cp.committed_offset) : -1;
    const actual = new Map((await allFires(repo)).map((f) => [f.source_ref_id, f]));
    const log = new MongoFeedLog(() => db);
    const tail = await log.tail();
    const proc = new SatelliteProcessor({ lateness_ms: Number(flag('lateness', '360')) * 60_000, evict_every_offsets: Number(flag('evict', '1000')) });
    const expected = new Map<string, HazardRecord>();
    const inFlight = new Set<string>();
    for (let from = 0; from <= tail; ) {
        const page = await log.read(from, 5000);
        if (page.length === 0) break;
        for (const e of page) {
            if (e.offset > tail) break;
            const d = proc.apply(e.offset, e.kind, e.raw).delta;
            for (const id of d.removed) {
                expected.delete(id);
                if (e.offset > committed) inFlight.add(id);
            }
            for (const f of d.upserts) {
                expected.set(f.fire_id, fireToHazard(f, ''));
                if (e.offset > committed) inFlight.add(f.fire_id);
            }
        }
        from = page[page.length - 1]!.offset + 1;
    }
    const missing: string[] = [];
    const extra: string[] = [];
    const different: string[] = [];
    let skipped = 0;
    for (const [id, e] of expected) {
        if (inFlight.has(id)) continue;
        const a = actual.get(id);
        if (!a) missing.push(id);
        else if (stable({ ...a, ingested_at: '' }) !== stable({ ...e, ingested_at: '' })) different.push(id);
    }
    for (const id of actual.keys()) if (!expected.has(id) && !inFlight.has(id)) extra.push(id);
    skipped = inFlight.size;
    const ok = missing.length + extra.length + different.length === 0;
    console.log(JSON.stringify({ ok, committed_offset: committed, log_tail: tail, expected_fires: expected.size, stored_fires: actual.size, in_flight_excluded: skipped, missing, extra, different }, null, 2));
    if (!ok) process.exitCode = 1;
}

async function report(repo: MongoCanonicalRepository, db: import('mongodb').Db): Promise<void> {
    const fires = await allFires(repo);
    const bySeverity: Record<string, number> = {};
    for (const f of fires) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    console.log(
        JSON.stringify(
            {
                fires: fires.length,
                by_severity: bySeverity,
                checksum: await repo.checksum('SATELIT'),
                feed_log_frames: await db.collection('satellite_feed_log').countDocuments(),
                late_detections: await db.collection('satellite_late_detections').countDocuments(),
            },
            null,
            2
        )
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
