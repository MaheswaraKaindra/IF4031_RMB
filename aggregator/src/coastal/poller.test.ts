import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { InMemoryCheckpointStore } from '../coordination/checkpoints.js';
import { InMemorySourceFenceStore } from '../coordination/fencing.js';
import type { LeaderLeaseHandle } from '../coordination/leaderLoop.js';
import { Bulkhead } from '../resilience/bulkhead.js';
import { CircuitBreaker, DEFAULT_BREAKER } from '../resilience/breaker.js';
import { InMemoryRepository } from '../storage/memory.js';
import { SensorFreshness } from './freshness.js';
import { InMemoryDeliveryLedger, deliveryKey } from './ledger.js';
import { COASTAL_SOURCE, CoastalPoller, type QuarantineInput } from './poller.js';
import { relayDeliveries } from './relay.js';
import { SensorRequestError, type ObservationQuery, type SensorClient } from './sensorClient.js';

const STATIONS = {
    items: [
        { station_id: 'stn-a', name: 'A', province: 'Aceh', latitude: 5.5, longitude: 95.3 },
        { station_id: 'stn-b', name: 'B', province: 'Jawa Barat', latitude: -7, longitude: 106.5 },
    ],
};
const T0 = Date.parse('2026-11-12T00:00:00Z');
const iso = (offsetS: number): string => new Date(T0 + offsetS * 1000).toISOString().replace('.000Z', 'Z');

function obs(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        observation_id: `obs-${String(n).padStart(6, '0')}`,
        station_id: n % 2 ? 'stn-a' : 'stn-b',
        observed_at: iso(n * 15),
        sea_level_anomaly_m: 0.1,
        wave_height_m: 1.2,
        quality: 'ok',
        critical: false,
        ...extra,
    };
}

class FakeSensor implements SensorClient {
    log: Obs[] = [];
    generatedAtS: number | undefined;
    failWith: SensorRequestError | undefined;
    calls = { stations: 0, observations: 0 };
    stationBody: unknown = STATIONS;
    async stations(): Promise<unknown> {
        this.calls.stations++;
        if (this.failWith) throw this.failWith;
        return this.stationBody;
    }
    async observations(q: ObservationQuery): Promise<unknown> {
        this.calls.observations++;
        if (this.failWith) throw this.failWith;
        const from = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
        const items = this.log.slice(from, from + q.limit);
        const next = from + items.length;
        const newest = this.log.length ? (Date.parse(String(this.log[this.log.length - 1]!['observed_at'])) - T0) / 1000 : 0;
        return { generated_at: iso(this.generatedAtS ?? newest + 10), items, next_cursor: items.length ? Buffer.from(String(next)).toString('base64url') : null };
    }
}
type Obs = Record<string, unknown>;

function setup(opts: { sensor?: FakeSensor; repo?: InMemoryRepository; checkpoints?: InMemoryCheckpointStore; ledger?: InMemoryDeliveryLedger } = {}) {
    let wall = 1_000_000;
    const sensor = opts.sensor ?? new FakeSensor();
    const repo = opts.repo ?? new InMemoryRepository();
    const checkpoints = opts.checkpoints ?? new InMemoryCheckpointStore();
    const fence = new InMemorySourceFenceStore();
    const ledger = opts.ledger ?? new InMemoryDeliveryLedger(() => wall);
    const quarantined: QuarantineInput[] = [];
    const created: string[] = [];
    const counters = new Map<string, number>();
    const breaker = new CircuitBreaker({ ...DEFAULT_BREAKER, jitter: 0, now: () => wall });
    let epoch = 0;
    const handleFor = async (): Promise<LeaderLeaseHandle> => {
        epoch = await fence.activateEpoch(COASTAL_SOURCE, 'test');
        return { epoch, signal: new AbortController().signal, isStillValid: () => true };
    };
    const make = (): CoastalPoller => {
        const freshness = new SensorFreshness(undefined, () => ['stn-a', 'stn-b']);
        return new CoastalPoller({
            client: sensor,
            breaker,
            bulkhead: new Bulkhead('coastal', 1),
            freshness,
            repo,
            fenceStore: fence,
            ledger,
            checkpoints,
            quarantine: async (q) => void quarantined.push(q),
            onCreated: (e) => void created.push(e.hazard_id),
            markSource: async () => undefined,
            metrics: {
                inc: (n, l, d = 1) => void counters.set(`${n}|${JSON.stringify(l ?? {})}`, (counters.get(`${n}|${JSON.stringify(l ?? {})}`) ?? 0) + d),
                set: () => undefined,
                observe: () => undefined,
            },
            logger: pino({ level: 'silent' }),
            now: () => wall,
            cfg: { pageSize: 5 },
        });
    };
    return { sensor, repo, checkpoints, fence, ledger, quarantined, created, counters, breaker, handleFor, make, advance: (ms: number) => void (wall += ms), wall: () => wall };
}

const count = (c: Map<string, number>, name: string, labels: Record<string, string>): number => c.get(`${name}|${JSON.stringify(labels)}`) ?? 0;

test('valid observations are stored, invalid ones are quarantined with a reason', async () => {
    const s = setup();
    s.sensor.log = [obs(1), obs(2, { wave_height_m: 'big' }), obs(3, { station_id: 'stn-zzz' }), obs(4, { observation_id: undefined })];
    const handle = await s.handleFor();
    assert.equal(await s.make().tick(handle), 'ok');
    assert.equal(s.created.length, 1);
    assert.deepEqual(
        s.quarantined.map((q) => q.reason),
        ['bad_type:wave_height_m', 'unknown_station', 'missing_field:observation_id'],
    );
    assert.equal((await s.repo.queryGlobal({ sort: 'occurred_desc', limit: 10, filter: { source: 'SENSOR_PANTAI' } })).items.length, 1);
});

test('duplicates are idempotent and a reused id with different content is kept as a separate record', async () => {
    const s = setup();
    s.sensor.log = [obs(1), obs(1), obs(2), obs(2, { wave_height_m: 9, critical: true })];
    await s.make().tick(await s.handleFor());
    assert.equal(s.created.length, 3, 'obs-1 once, obs-2 and its conflicting variant');
    assert.equal(s.quarantined.length, 0);
    assert.equal(s.ledger.entries.size, 1, 'the critical variant is not lost');
    const e = [...s.ledger.entries.values()][0]!;
    assert.match(e.event.source_ref_id, /^obs-000002~[0-9a-f]{8}$/);
    assert.equal(e.event.attributes['id_reused_for_different_content'], true);
});

test('a sensor that restarts (clock goes backwards) is read again from the start and nothing is lost', async () => {
    const s = setup();
    s.sensor.log = Array.from({ length: 12 }, (_, i) => obs(i));
    const p = s.make();
    const handle = await s.handleFor();
    await p.tick(handle);
    assert.equal(s.created.length, 12);
    s.sensor.log = [obs(0), obs(1, { critical: true, wave_height_m: 7 }), obs(2), obs(3, { observation_id: 'obs-new-3' })];
    s.sensor.generatedAtS = 100;
    assert.equal(await p.tick(handle), 'ok');
    assert.equal(s.created.length, 14, 'one reused id with new content and one new id, the identical ones are no-ops');
    assert.equal(s.ledger.entries.size, 1, 'the critical observation after the restart is delivered');
    assert.equal(count(s.counters, 'coastal_sensor_resets_total', {}), 1);
});

test('the cursor survives a restart and a null cursor never rewinds the stream', async () => {
    const s = setup();
    s.sensor.log = Array.from({ length: 12 }, (_, i) => obs(i));
    const handle = await s.handleFor();
    const p1 = s.make();
    await p1.tick(handle);
    assert.equal(s.created.length, 12);
    s.sensor.calls.observations = 0;
    const p2 = s.make();
    await p2.tick(await s.handleFor());
    assert.equal(s.created.length, 12, 'nothing re-ingested after restart');
    assert.equal(s.sensor.calls.observations, 1, 'one request, the final empty page');
    await p2.tick(handle);
    assert.equal(s.created.length, 12);
});

test('critical observations register a delivery before the canonical write and are marked applied', async () => {
    const s = setup();
    s.sensor.log = [obs(1, { critical: true }), obs(2)];
    await s.make().tick(await s.handleFor());
    assert.equal(s.ledger.entries.size, 1);
    const e = [...s.ledger.entries.values()][0]!;
    assert.equal(e.canonical_applied, true);
    assert.equal(e.event.severity, 'AWAS');
    assert.equal(e.state, 'pending');
});

test('a storage outage holds the cursor and the retry converges without loss or duplicates', async () => {
    const s = setup();
    s.sensor.log = Array.from({ length: 6 }, (_, i) => obs(i, i === 4 ? { critical: true } : {}));
    const real = s.repo.ingest.bind(s.repo);
    let fail = true;
    s.repo.ingest = async (input) => (fail && input.event.source_ref_id === 'obs-000004' ? { outcome: 'unavailable', hazard_id: 'x' } : real(input));
    const p = s.make();
    const handle = await s.handleFor();
    assert.equal(await p.tick(handle), 'storage_retry');
    fail = false;
    assert.equal(await p.tick(handle), 'ok');
    assert.equal(s.created.length, 6);
    assert.equal(s.ledger.entries.size, 1);
    assert.equal([...s.ledger.entries.values()][0]!.canonical_applied, true);
});

test('a stale leader is fenced and writes nothing', async () => {
    const s = setup();
    s.sensor.log = [obs(1)];
    const old = await s.handleFor();
    await s.handleFor();
    assert.equal(await s.make().tick(old), 'stale_epoch');
    assert.equal(s.created.length, 0);
});

test('a sick sensor opens the breaker, requests stop, and probes recover it without intervention', async () => {
    const s = setup();
    s.sensor.log = [obs(1)];
    const p = s.make();
    const handle = await s.handleFor();
    s.sensor.failWith = new SensorRequestError('timeout', 'timeout');
    for (let i = 0; i < 5; i++) assert.equal(await p.tick(handle), 'request_failed');
    assert.equal(s.breaker.state, 'open');
    const callsAtOpen = s.sensor.calls.stations + s.sensor.calls.observations;
    for (let i = 0; i < 20; i++) {
        assert.equal(await p.tick(handle), 'skipped_breaker');
        s.advance(100);
    }
    assert.equal(s.sensor.calls.stations + s.sensor.calls.observations, callsAtOpen, 'no request while open');
    s.advance(20_000);
    assert.equal(await p.tick(handle), 'request_failed', 'probe against a still sick sensor');
    assert.equal(s.breaker.state, 'open');
    s.sensor.failWith = undefined;
    s.advance(40_000);
    assert.equal(await p.tick(handle), 'ok');
    assert.equal(s.breaker.state, 'closed');
    assert.equal(s.created.length, 1);
});

test('a stale sensor that still answers healthz-style 200 counts as a failure', async () => {
    const s = setup();
    s.sensor.log = [obs(1)];
    s.sensor.generatedAtS = 100_000;
    const p = s.make();
    const handle = await s.handleFor();
    for (let i = 0; i < 5; i++) assert.equal(await p.tick(handle), 'unhealthy');
    assert.equal(s.breaker.state, 'open');
    assert.equal(s.created.length, 1, 'data is still stored with its lag, not discarded');
});

test('a response that violates the contract is quarantined and counted as a failure', async () => {
    const s = setup();
    const p = s.make();
    const handle = await s.handleFor();
    s.sensor.observations = async () => ({ items: 'nope' });
    assert.equal(await p.tick(handle), 'contract_failed');
    assert.equal(s.quarantined[0]!.reason, 'response_contract:items_not_array');
    s.sensor.observations = async () => ({ generated_at: 'yesterday', items: [] });
    assert.equal(await p.tick(handle), 'contract_failed');
    assert.equal(s.quarantined[1]!.reason, 'response_contract:bad_generated_at');
    assert.equal(count(s.counters, 'coastal_observations_total', { outcome: 'quarantined' }), 2);
});

test('relay publishes, backs off on failure, republishes until acked, and ack is idempotent', async () => {
    const s = setup();
    s.sensor.log = [obs(1, { critical: true })];
    await s.make().tick(await s.handleFor());
    const id = [...s.ledger.entries.keys()][0]!;
    const hazardId = s.ledger.entries.get(id)!.hazard_id;
    const sent: string[] = [];
    let broken = true;
    const publish = async (e: { hazard_id: string }): Promise<void> => {
        if (broken) throw new Error('broker down');
        sent.push(e.hazard_id);
    };
    const m = { inc: () => undefined };
    assert.deepEqual(await relayDeliveries(s.ledger, publish, m, { batch: 10, visibilityMs: 5000 }), { published: 0, failed: 1 });
    assert.deepEqual(await relayDeliveries(s.ledger, publish, m, { batch: 10, visibilityMs: 5000 }), { published: 0, failed: 0 }, 'backed off');
    broken = false;
    s.advance(5_100);
    assert.deepEqual(await relayDeliveries(s.ledger, publish, m, { batch: 10, visibilityMs: 5000 }), { published: 1, failed: 0 });
    assert.equal(s.ledger.entries.get(id)!.state, 'published');
    s.advance(11_000);
    await relayDeliveries(s.ledger, publish, m, { batch: 10, visibilityMs: 5000 });
    assert.equal(sent.length, 2, 'unacknowledged delivery is republished');
    s.advance(500);
    const a1 = await s.ledger.ack(hazardId, 'field-team');
    const a2 = await s.ledger.ack(hazardId, 'field-team');
    assert.equal(a1.first, true);
    assert.equal(a2.first, false);
    assert.equal(a2.latencyMs, a1.latencyMs);
    s.advance(60_000);
    await relayDeliveries(s.ledger, publish, m, { batch: 10, visibilityMs: 5000 });
    assert.equal(sent.length, 2, 'acknowledged delivery is never published again');
    assert.equal((await s.ledger.ack('hz-unknown', 'field-team')).known, false);
    assert.equal(deliveryKey(hazardId), id);
});

test('delivery report counts undelivered events in the denominator and against the deadline', async () => {
    const s = setup();
    s.sensor.log = [obs(1, { critical: true }), obs(2, { critical: true }), obs(3, { critical: true })];
    await s.make().tick(await s.handleFor());
    const ids = [...s.ledger.entries.values()].map((e) => e.hazard_id);
    s.advance(1_000);
    await s.ledger.ack(ids[0]!, 'field-team');
    s.advance(6_000);
    await s.ledger.ack(ids[1]!, 'field-team');
    const r = await s.ledger.report(5_000);
    assert.equal(r.expected, 3);
    assert.equal(r.delivered, 2);
    assert.equal(r.undelivered, 1);
    assert.equal(r.withinDeadline, 1);
    assert.equal(r.deadlineMisses, 2);
});

test('a critical observation deep in a backlog is delivered before the ordinary ones ahead of it', async () => {
    const s = setup();
    s.sensor.log = Array.from({ length: 20 }, (_, i) => obs(i, i === 17 ? { critical: true } : {}));
    const order: string[] = [];
    const real = s.repo.ingest.bind(s.repo);
    s.repo.ingest = async (input) => {
        order.push(String(input.event.source_ref_id));
        return real(input);
    };
    await s.make().tick(await s.handleFor());
    assert.equal(s.created.length, 20, 'everything is still stored once');
    assert.equal(order.indexOf('obs-000017'), 0, 'the critical one is written first');
    assert.equal(s.ledger.entries.size, 1);
    assert.equal([...s.ledger.entries.values()][0]!.canonical_applied, true);
});

test('a critical alert is published before the store is reached, once, even while the store is down', async () => {
    const s = setup();
    s.sensor.log = [obs(1, { critical: true }), obs(2)];
    const sent: string[] = [];
    const real = s.ledger.register.bind(s.ledger);
    let down = true;
    s.ledger.register = async (e, t) => {
        if (down) throw new Error('store down');
        return real(e, t);
    };
    const p = new CoastalPoller({
        client: s.sensor, breaker: s.breaker, bulkhead: new Bulkhead('coastal', 1), freshness: new SensorFreshness(undefined, () => []),
        repo: s.repo, fenceStore: s.fence, ledger: s.ledger, checkpoints: s.checkpoints, quarantine: async () => undefined,
        onCreated: () => undefined, markSource: async () => undefined, metrics: { inc: () => undefined, set: () => undefined, observe: () => undefined },
        logger: pino({ level: 'silent' }), now: () => s.wall(), cfg: { pageSize: 5 },
        fastPublish: async (e) => void sent.push(e.hazard_id),
    });
    const handle = await s.handleFor();
    assert.equal(await p.tick(handle), 'storage_retry');
    assert.equal(await p.tick(handle), 'storage_retry');
    assert.equal(sent.length, 1, 'published once although the store retry repeats');
    down = false;
    assert.equal(await p.tick(handle), 'ok');
    assert.equal(sent.length, 1);
    assert.equal(s.ledger.entries.size, 1, 'the ledger still carries the guarantee');
});

test('an unavailable checkpoint store does not stop the poller from asking the sensor and alerting', async () => {
    const s = setup();
    s.sensor.log = [obs(1), obs(2)];
    const sent: string[] = [];
    const realCommit = s.checkpoints.commit.bind(s.checkpoints);
    let down = true;
    s.checkpoints.commit = async (next, expected) => (down ? 'unavailable' : realCommit(next, expected));
    const realGet = s.checkpoints.get.bind(s.checkpoints);
    s.checkpoints.get = async (a, b) => {
        if (down && s.sensor.calls.observations > 0) throw new Error('store down');
        return realGet(a, b);
    };
    const p = new CoastalPoller({
        client: s.sensor, breaker: s.breaker, bulkhead: new Bulkhead('coastal', 1), freshness: new SensorFreshness(undefined, () => []),
        repo: s.repo, fenceStore: s.fence, ledger: s.ledger, checkpoints: s.checkpoints, quarantine: async () => undefined,
        onCreated: () => undefined, markSource: async () => undefined, metrics: { inc: () => undefined, set: () => undefined, observe: () => undefined },
        logger: pino({ level: 'silent' }), now: () => s.wall(), cfg: { pageSize: 5 },
        fastPublish: async (e) => void sent.push(e.hazard_id),
    });
    const handle = await s.handleFor();
    assert.equal(await p.tick(handle), 'storage_retry');
    s.sensor.log.push(obs(3, { critical: true }));
    const callsBefore = s.sensor.calls.observations;
    assert.equal(await p.tick(handle), 'storage_retry');
    assert.ok(s.sensor.calls.observations > callsBefore, 'the sensor was asked again although the checkpoint store is down');
    assert.equal(sent.length, 1, 'the critical alert went out during the store outage');
    down = false;
    assert.equal(await p.tick(handle), 'ok');
    const stored = await s.repo.queryGlobal({ sort: 'occurred_desc', limit: 10, filter: { source: 'SENSOR_PANTAI' } });
    assert.equal(stored.items.length, 3, 'everything is stored once the store is back');
});

test('a cursor that points past the end of a replaced sensor log is dropped after a long silence, without the clock going back', async () => {
    const s = setup();
    s.sensor.log = Array.from({ length: 12 }, (_, i) => obs(i));
    const p = s.make();
    const handle = await s.handleFor();
    await p.tick(handle);
    assert.equal(s.created.length, 12);
    s.sensor.log = Array.from({ length: 4 }, (_, i) => obs(100 + i));
    s.sensor.generatedAtS = 175;
    await p.tick(handle);
    assert.equal(s.created.length, 12, 'nothing visible yet: the cursor is beyond the new log');
    s.sensor.generatedAtS = 2000;
    await p.tick(handle);
    assert.equal(s.created.length, 16, 'after the silence the log is read from the start');
    assert.equal(count(s.counters, 'coastal_blind_rewinds_total', {}), 1);
});
