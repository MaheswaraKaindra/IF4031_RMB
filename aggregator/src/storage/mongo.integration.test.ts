// MongoCanonicalRepository against a REAL MongoDB, checked against the in-memory reference implementation.
// Skipped unless MONGO_TEST_URI is set (it needs a server):
//   single node:  docker run -d --rm -p 27018:27017 --name bnpb-mongo-test mongo:7
//                 MONGO_TEST_URI=mongodb://localhost:27018 npm run test:mongo
//   sharded:      port-forward svc/mongos and use an admin user; MONGO_TEST_SHARDED=1 shards the throwaway database
//                 (hashed _id, like production) so ordering, paging and scans really cross shards.
// Every run uses its own database and drops it afterwards; it never touches bnpb_canonical_store.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoCanonicalRepository } from './mongoRepository.js';
import { InMemoryRepository } from './memory.js';
import { compareRecords } from './merge.js';
import type { AnalyticsResult, HazardRecord, HazardType, ICanonicalRepository, Severity, SortOrder } from './types.js';

const URI = process.env.MONGO_TEST_URI;
const SHARDED = process.env.MONGO_TEST_SHARDED === '1';
const DB = `bnpb_adapter_test_${process.pid}_${Date.now()}`;
const skip = URI ? false : 'MONGO_TEST_URI not set';

let client: MongoClient;
let repo: MongoCanonicalRepository;

function rec(i: number, over: Partial<HazardRecord> = {}): HazardRecord {
    const types: HazardType[] = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL'];
    const sev: Severity[] = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    const t = Date.UTC(2026, 10, 1) + (i % 25) * 60_000; // many identical keys: the hazard_id tie breaker matters
    return {
        hazard_id: 'ignored', source: i % 2 ? 'BMKG' : 'PVMBG', source_ref_id: `ref-${i}`,
        hazard_type: types[i % 4]!, severity: sev[i % 4]!, area_name: `area-${i % 5}`,
        latitude: -2, longitude: 110, occurred_at: new Date(t).toISOString(),
        ingested_at: new Date(Date.UTC(2026, 10, 2) + (i % 40) * 1000).toISOString(),
        attributes: i % 8 === 0 ? { potential_tsunami: true } : {}, ...over,
    };
}

async function pageAll(r: ICanonicalRepository, sort: SortOrder, size: number, filter?: Parameters<ICanonicalRepository['queryGlobal']>[0]['filter']): Promise<HazardRecord[]> {
    const all: HazardRecord[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
        const p = await r.queryGlobal({ sort, limit: size, cursor, filter });
        assert.equal(p.partial, false, 'healthy store answers complete');
        all.push(...p.items);
        if (!p.next_cursor) return all;
        cursor = p.next_cursor;
    }
    throw new Error('pagination did not terminate');
}

function stripAsOf(a: AnalyticsResult): Omit<AnalyticsResult, 'as_of'> {
    const { as_of, ...rest } = a;
    void as_of;
    return rest;
}

before(async () => {
    if (!URI) return;
    client = await new MongoClient(URI, { serverSelectionTimeoutMS: 5000 }).connect();
    if (SHARDED) {
        await client.db('admin').command({ enableSharding: DB });
        await client.db('admin').command({ shardCollection: `${DB}.hazards`, key: { _id: 'hashed' } });
    }
    // Same secondary indexes as production (src/db/mongo.ts).
    const h = client.db(DB).collection('hazards');
    await h.createIndex({ occurred_at: -1, hazard_id: 1 });
    await h.createIndex({ ingested_at: 1, hazard_id: 1 });
    repo = new MongoCanonicalRepository({ client, dbName: DB, deadlineMs: 5000, scanPageSize: 7, ingestedAtSource: 'caller' });
});

after(async () => {
    if (!URI) return;
    await repo.close();
    await client.db(DB).dropDatabase().catch(() => undefined);
    await client.close();
});

async function reset(): Promise<void> {
    await client.db(DB).collection('hazards').deleteMany({});
}

test('ingest: idempotent replay, versions, fencing epochs, remove', { skip }, async () => {
    await reset();
    const first = await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 });
    assert.deepEqual([first.outcome, first.created], ['applied', true]);
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 })).outcome, 'duplicate');
    assert.equal((await repo.ingest({ event: rec(1, { severity: 'AWAS' }), eventVersion: 2, epoch: 7 })).outcome, 'applied');
    assert.equal((await repo.getById(first.hazard_id))?.severity, 'AWAS');
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 })).outcome, 'stale_version');
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 3, epoch: 6 })).outcome, 'stale_epoch');
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 3, epoch: 8 })).outcome, 'applied');
    assert.equal((await repo.remove(first.hazard_id, 7)).outcome, 'stale_epoch');
    assert.equal((await repo.remove(first.hazard_id, 8)).outcome, 'applied');
    assert.equal(await repo.getById(first.hazard_id), null);
    assert.equal((await repo.checksum()).count, 0);
});

test('ingest without version/epoch (M1 pollers): replay is a duplicate and keeps the first ingested_at', { skip }, async () => {
    await reset();
    const a = await repo.ingest({ event: rec(2) });
    const b = await repo.ingest({ event: rec(2, { ingested_at: '2030-01-01T00:00:00.000Z' }) });
    assert.deepEqual([a.created, b.outcome, b.created], [true, 'duplicate', false]);
    assert.equal((await repo.getById(a.hazard_id))?.ingested_at, rec(2).ingested_at);
});

test('concurrent duplicate upserts of one record create it exactly once', { skip }, async () => {
    await reset();
    const results = await Promise.all(Array.from({ length: 20 }, () => repo.ingest({ event: rec(3) })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.ok(results.every((r) => r.outcome === 'applied' || r.outcome === 'duplicate'));
    assert.equal((await repo.checksum()).count, 1);
});

test('paging, checksum and analytics match the reference implementation', { skip }, async () => {
    await reset();
    const ref = new InMemoryRepository(3);
    const n = 250;
    for (let i = 0; i < n; i++) {
        const e = rec(i);
        assert.equal((await repo.ingest({ event: e })).outcome, 'applied');
        await ref.ingest({ event: e });
    }

    for (const sort of ['occurred_desc', 'ingested_asc'] as const) {
        for (const size of [1, 17, 1000]) {
            const got = await pageAll(repo, sort, size);
            assert.equal(got.length, n, `${sort}/${size}: every record exactly once`);
            assert.equal(new Set(got.map((r) => r.hazard_id)).size, n);
            assert.deepEqual(got.map((r) => r.hazard_id), [...got].sort((a, b) => compareRecords(a, b, sort)).map((r) => r.hazard_id));
            assert.deepEqual(got.map((r) => r.hazard_id), (await pageAll(ref, sort, size)).map((r) => r.hazard_id), `${sort}/${size}: same order as reference`);
        }
    }
    const filter = { source: 'BMKG' as const, hazard_type: 'VOLCANIC' as const };
    assert.deepEqual((await pageAll(repo, 'occurred_desc', 9, filter)).map((r) => r.hazard_id),
        (await pageAll(ref, 'occurred_desc', 9, filter)).map((r) => r.hazard_id));
    const since = rec(10).occurred_at;
    assert.deepEqual((await pageAll(repo, 'occurred_desc', 9, { since })).map((r) => r.hazard_id),
        (await pageAll(ref, 'occurred_desc', 9, { since })).map((r) => r.hazard_id));

    // Full scans run in keyset pages of 7 here (scanPageSize): 250 records cross ~36 page boundaries.
    for (const source of [undefined, 'BMKG', 'PVMBG'] as const) {
        const [a, b] = [await repo.checksum(source), await ref.checksum(source)];
        assert.deepEqual([a.count, a.checksum, a.partial], [b.count, b.checksum, false], `checksum ${source ?? 'ALL'}`);
    }
    for (const bucket of ['hour', 'day'] as const) {
        assert.deepEqual(stripAsOf(await repo.aggregate({ bucket })), stripAsOf(await ref.aggregate({ bucket })), `analytics ${bucket}`);
    }
    const window = { from: rec(3).occurred_at, to: rec(20).occurred_at, bucket: 'hour' as const };
    assert.deepEqual(stripAsOf(await repo.aggregate(window)), stripAsOf(await ref.aggregate(window)));
});

test('stored documents keep internal fields out of the API shape', { skip }, async () => {
    await reset();
    const r = await repo.ingest({ event: rec(5), eventVersion: 4, epoch: 2 });
    const got = await repo.getById(r.hazard_id);
    assert.ok(got);
    assert.equal(got.hazard_id, r.hazard_id);
    for (const k of ['_id', 'event_version', 'fence_epoch']) assert.equal(k in got, false, `${k} leaked`);
    assert.equal((await repo.queryGlobal({ sort: 'ingested_asc', limit: 5 })).items[0]?.hazard_id, r.hazard_id);
});

test('store clock: ingested_at comes from the database, not from the record, and is set once', { skip }, async () => {
    await reset();
    const storeRepo = new MongoCanonicalRepository({ client, dbName: DB, deadlineMs: 5000 });
    try {
        const skewed = rec(1, { ingested_at: '2099-01-01T00:00:00.000Z' });
        const before = Date.now();
        const first = await storeRepo.ingest({ event: skewed, eventVersion: 1, epoch: 1 });
        const after = Date.now();
        assert.equal(first.outcome, 'applied');
        assert.equal(first.created, true);
        const stored = await storeRepo.getById(first.hazard_id);
        const stamp = Date.parse(stored!.ingested_at);
        assert.ok(stamp >= before - 2000 && stamp <= after + 2000, `stamp ${stored!.ingested_at} should be the store time, not the record's 2099`);
        assert.match(stored!.ingested_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        await new Promise((r) => setTimeout(r, 30));
        const again = await storeRepo.ingest({ event: { ...skewed, severity: 'AWAS' }, eventVersion: 2, epoch: 1 });
        assert.equal(again.outcome, 'applied');
        assert.equal(again.created, false);
        const updated = await storeRepo.getById(first.hazard_id);
        assert.equal(updated!.ingested_at, stored!.ingested_at, 'a later write must not move ingested_at');
        assert.equal(updated!.severity, 'AWAS');

        const same = await storeRepo.ingest({ event: { ...skewed, severity: 'AWAS' }, eventVersion: 2, epoch: 1 });
        assert.equal(same.outcome, 'duplicate');
    } finally {
        await storeRepo.close();
    }
});

test('pipeline update stores values that start with a dollar sign literally and keeps fencing', { skip }, async () => {
    await reset();
    const storeRepo = new MongoCanonicalRepository({ client, dbName: DB, deadlineMs: 5000 });
    try {
        const tricky = rec(2, { area_name: '$ref', attributes: { note: '$$NOW', nested: { a: '$b' }, list: ['$c', { $d: 1 }] } });
        const r = await storeRepo.ingest({ event: tricky, eventVersion: 1, epoch: 5 });
        assert.equal(r.outcome, 'applied');
        const got = await storeRepo.getById(r.hazard_id);
        assert.equal(got!.area_name, '$ref');
        assert.deepEqual(got!.attributes, { note: '$$NOW', nested: { a: '$b' }, list: ['$c', { $d: 1 }] });
        const stale = await storeRepo.ingest({ event: tricky, eventVersion: 2, epoch: 4 });
        assert.equal(stale.outcome, 'stale_epoch');
        const raised = await storeRepo.ingest({ event: tricky, eventVersion: 3, epoch: 9 });
        assert.equal(raised.outcome, 'applied');
        const after = await storeRepo.ingest({ event: tricky, eventVersion: 4, epoch: 7 });
        assert.equal(after.outcome, 'stale_epoch', 'the fence epoch only ever goes up');
    } finally {
        await storeRepo.close();
    }
});
