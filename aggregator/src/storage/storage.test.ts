import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { MongoClient } from 'mongodb';
import { MongoCanonicalRepository } from './mongoRepository.js';
import { checksumOfRefs, compareRecords } from './merge.js';
import { hazardIdFor } from './identity.js';
import { InMemoryRepository } from './memory.js';
import { createStorageRouter } from './routes.js';
import { InvalidCursorError, type HazardRecord, type HazardType, type Severity, type SortOrder } from './types.js';

function rec(i: number, over: Partial<HazardRecord> = {}): HazardRecord {
    const types: HazardType[] = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL'];
    const sev: Severity[] = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    const t = Date.UTC(2026, 10, 1) + (i % 25) * 60_000; // many identical timestamps: exercises the hazard_id tie breaker
    return {
        hazard_id: 'x', source: i % 2 ? 'BMKG' : 'PVMBG', source_ref_id: `ref-${i}`,
        hazard_type: types[i % 4]!, severity: sev[i % 4]!, area_name: `area-${i % 5}`,
        latitude: -2, longitude: 110, occurred_at: new Date(t).toISOString(),
        ingested_at: new Date(Date.UTC(2026, 10, 2) + (i % 40) * 1000).toISOString(),
        attributes: i % 8 === 0 ? { potential_tsunami: true } : {}, ...over,
    };
}

async function filled(n = 200): Promise<InMemoryRepository> {
    const repo = new InMemoryRepository(3);
    for (let i = 0; i < n; i++) assert.equal((await repo.ingest({ event: rec(i) })).outcome, 'applied');
    return repo;
}

async function pageAll(repo: InMemoryRepository, sort: SortOrder, size: number): Promise<HazardRecord[]> {
    const all: HazardRecord[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1000; guard++) {
        const p = await repo.queryGlobal({ sort, limit: size, cursor });
        all.push(...p.items);
        if (!p.next_cursor) return all;
        cursor = p.next_cursor;
    }
    throw new Error('pagination did not terminate');
}

test('identity is deterministic and source-scoped', () => {
    assert.equal(hazardIdFor('BMKG', 'a'), hazardIdFor('BMKG', 'a'));
    assert.notEqual(hazardIdFor('BMKG', 'a'), hazardIdFor('PVMBG', 'a'));
    assert.match(hazardIdFor('BMKG', 'a'), /^hz-[0-9a-f]{16}$/);
});

test('checksum: byte-ordered, newline joined, no trailing newline', () => {
    const expected = createHash('sha256').update('Z\na\nb').digest('hex'); // 'Z' (0x5a) sorts before 'a' (0x61)
    assert.equal(checksumOfRefs(['b', 'a', 'Z']), expected);
    assert.equal(checksumOfRefs([]), createHash('sha256').update('').digest('hex'));
});

for (const sort of ['occurred_desc', 'ingested_asc'] as const) {
    test(`global ${sort}: pages across units equal the global order, no gaps or duplicates`, async () => {
        const repo = await filled(200);
        const paged = await pageAll(repo, sort, 17);
        assert.equal(paged.length, 200);
        assert.equal(new Set(paged.map((r) => r.hazard_id)).size, 200);
        const expected = [...paged].sort((a, b) => compareRecords(a, b, sort));
        assert.deepEqual(paged.map((r) => r.hazard_id), expected.map((r) => r.hazard_id));
    });
}

test('50 latest events across all hazard types is the true top 50', async () => {
    const repo = await filled(200);
    const all = await pageAll(repo, 'occurred_desc', 1000);
    const top = await repo.queryGlobal({ sort: 'occurred_desc', limit: 50 });
    assert.deepEqual(top.items.map((r) => r.hazard_id), all.slice(0, 50).map((r) => r.hazard_id));
    assert.equal(new Set(top.items.map((r) => r.hazard_type)).size, 4);
    assert.equal(top.partial, false);
});

test('unit down: answers with explicit partial marker; recovered unit returns complete data', async () => {
    const repo = await filled(200);
    repo.setUnitDown(1, true);
    const p = await repo.queryGlobal({ sort: 'ingested_asc', limit: 1000 });
    assert.equal(p.partial, true);
    assert.deepEqual(p.unavailable_units, ['shard-2']);
    assert.ok(p.items.length > 0 && p.items.length < 200);
    assert.equal((await repo.checksum()).partial, true);
    assert.equal((await repo.aggregate({ bucket: 'day' })).partial, true);
    repo.setUnitDown(1, false);
    const full = await repo.queryGlobal({ sort: 'ingested_asc', limit: 1000 });
    assert.equal(full.partial, false);
    assert.equal(full.items.length, 200);
});

test('writes to an unreachable unit report unavailable (unknown outcome), never a false ack', async () => {
    const repo = new InMemoryRepository(3);
    repo.setUnitDown(0, true);
    repo.setUnitDown(1, true);
    repo.setUnitDown(2, true);
    assert.equal((await repo.ingest({ event: rec(1) })).outcome, 'unavailable');
});

test('ingest: idempotent replay, versions, fencing epochs', async () => {
    const repo = new InMemoryRepository(3);
    const first = await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 });
    assert.deepEqual([first.outcome, first.created], ['applied', true]);
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 })).outcome, 'duplicate');
    assert.equal((await repo.ingest({ event: rec(1, { severity: 'AWAS' }), eventVersion: 2, epoch: 7 })).outcome, 'applied');
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 1, epoch: 7 })).outcome, 'stale_version');
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 3, epoch: 6 })).outcome, 'stale_epoch'); // frozen leader resumes
    assert.equal((await repo.ingest({ event: rec(1), eventVersion: 3, epoch: 8 })).outcome, 'applied');
    assert.equal((await repo.remove(first.hazard_id, 7)).outcome, 'stale_epoch');
    assert.equal((await repo.remove(first.hazard_id, 8)).outcome, 'applied');
    assert.equal(await repo.getById(first.hazard_id), null);
    assert.equal((await repo.checksum()).count, 0);
});

test('the same logical record is never double counted', async () => {
    const repo = new InMemoryRepository(3);
    for (let n = 0; n < 5; n++) await repo.ingest({ event: rec(1) });
    assert.equal((await repo.checksum('PVMBG')).count + (await repo.checksum('BMKG')).count, 1);
});

test('analytics equals a direct count of the audit stream', async () => {
    const repo = await filled(200);
    const audit = await pageAll(repo, 'ingested_asc', 1000);
    const a = await repo.aggregate({ bucket: 'hour' });
    assert.equal(a.total, audit.length);
    for (const t of ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL']) {
        assert.equal(a.by_hazard_type[t], audit.filter((r) => r.hazard_type === t).length);
        assert.equal(Object.values(a.series[t]!).reduce((x, y) => x + y, 0), a.by_hazard_type[t]);
    }
    assert.equal(a.by_area['area-0'], audit.filter((r) => r.area_name === 'area-0').length);
    assert.equal(Object.values(a.series['TSUNAMI']!).reduce((x, y) => x + y, 0), a.tsunami_flagged);
    assert.equal(a.tsunami_flagged, audit.filter((r) => r.hazard_type === 'SEISMIC' && r.attributes['potential_tsunami']).length);
});

test('invalid or foreign cursors are rejected', async () => {
    const repo = await filled(10);
    await assert.rejects(repo.queryGlobal({ sort: 'occurred_desc', limit: 5, cursor: 'garbage' }), InvalidCursorError);
    const p = await repo.queryGlobal({ sort: 'occurred_desc', limit: 5 });
    await assert.rejects(repo.queryGlobal({ sort: 'ingested_asc', limit: 5, cursor: p.next_cursor! }), InvalidCursorError);
});

test('Audit API contract (Appendix A)', async () => {
    const repo = await filled(30);
    const app = express();
    app.use(createStorageRouter({ repo, auditToken: 'secret-token' }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = { authorization: 'Bearer secret-token' };
    try {
        let r = await fetch(`${base}/internal/audit/events`);
        assert.equal(r.status, 401);
        assert.deepEqual(await r.json(), { error: { code: 'unauthorized', message: 'token tidak valid' } });
        assert.equal((await fetch(`${base}/internal/audit/events?limit=0`, { headers: h })).status, 400);
        assert.equal((await fetch(`${base}/internal/audit/events?source=NOPE`, { headers: h })).status, 400);
        assert.equal((await fetch(`${base}/internal/audit/events?cursor=zzz`, { headers: h })).status, 400);

        r = await fetch(`${base}/internal/audit/events?limit=10`, { headers: h });
        const page = await r.json() as { items: HazardRecord[]; next_cursor: string | null; partial: boolean; unavailable_units: string[] };
        assert.equal(r.headers.get('content-type')?.startsWith('application/json'), true);
        assert.equal(page.items.length, 10);
        assert.equal(page.partial, false);
        assert.ok(page.next_cursor);
        const ids = page.items.map((i) => i.hazard_id);
        assert.deepEqual(ids, [...page.items].sort((a, b) => compareRecords(a, b, 'ingested_asc')).map((i) => i.hazard_id));

        const last = await (await fetch(`${base}/internal/audit/events?limit=1000`, { headers: h })).json() as typeof page;
        assert.equal(last.items.length, 30);
        assert.equal(last.next_cursor, null);

        const cs = await (await fetch(`${base}/internal/audit/checksum?source=BMKG`, { headers: h })).json() as Record<string, unknown>;
        assert.equal(cs['source'], 'BMKG');
        assert.equal(cs['algorithm'], 'sha256');
        assert.match(String(cs['checksum']), /^[0-9a-f]{64}$/);
        assert.equal(cs['count'], last.items.filter((i) => i.source === 'BMKG').length);

        assert.equal((await fetch(`${base}/internal/audit/location?hazard_id=hz-missing`, { headers: h })).status, 404);
        assert.equal((await fetch(`${base}/internal/audit/location`, { headers: h })).status, 400);
        const loc = await (await fetch(`${base}/internal/audit/location?hazard_id=${ids[0]}`, { headers: h })).json() as { locations: Array<{ role: string }> };
        assert.deepEqual(loc.locations.map((l) => l.role), ['primary', 'replica']);

        const un = await (await fetch(`${base}/internal/audit/unprocessed`, { headers: h })).json();
        assert.deepEqual(un, { items: [], next_cursor: null });

        repo.setUnitDown(2, true);
        const partial = await (await fetch(`${base}/internal/audit/events?limit=1000`, { headers: h })).json() as typeof page;
        assert.equal(partial.partial, true);
        assert.deepEqual(partial.unavailable_units, ['shard-3']);
        assert.equal((await fetch(`${base}/analytics`)).status, 200);
    } finally {
        server.close();
    }
});

test('unreachable storage never delays a request: cached background probes + bounded reads + explicit partial', async () => {
    // 192.0.2.1 (TEST-NET-1) is unroutable: connects hang until the probe/selection timeout, like a member whose node vanished.
    const client = new MongoClient('mongodb://192.0.2.1:27017/?serverSelectionTimeoutMS=300&connectTimeoutMS=300');
    const dead = (name: string) => ({ name, host: '192.0.2.1', node: 'node-x', arbiter: false });
    const repo = new MongoCanonicalRepository({
        client, topology: { units: [{ name: 'shard-1', members: [dead('a'), dead('b')] }] },
        deadlineMs: 500, probeTimeoutMs: 300, probeIntervalMs: 60_000,
    });
    try {
        let t = performance.now();
        const first = await repo.unitStatus();
        assert.ok(performance.now() - t < 1500, 'first probe is bounded by the probe timeout');
        assert.deepEqual(first.map((u) => [u.unit, u.available]), [['shard-1', false]]);

        t = performance.now();
        await repo.unitStatus();
        assert.ok(performance.now() - t < 50, 'subsequent status reads come from the cache');

        t = performance.now();
        const page = await repo.queryGlobal({ sort: 'occurred_desc', limit: 50 });
        assert.ok(performance.now() - t < 1500, 'a read answers well inside the 2s client-api timeout');
        assert.equal(page.partial, true);
        assert.deepEqual(page.unavailable_units, ['shard-1']);

        const agg = await repo.aggregate({ bucket: 'day' });
        assert.equal(agg.partial, true);
        const cs = await repo.checksum();
        assert.equal(cs.partial, true);
        assert.match(cs.checksum, /^[0-9a-f]{64}$/);
    } finally {
        await repo.close();
        await client.close();
    }
});

test('an unreachable store reports an unknown write outcome, never a false success', async () => {
    const client = new MongoClient('mongodb://192.0.2.1:27017/?serverSelectionTimeoutMS=300&connectTimeoutMS=300');
    const repo = new MongoCanonicalRepository({ client, deadlineMs: 300 });
    try {
        const r = await repo.ingest({ event: rec(1) });
        assert.equal(r.outcome, 'unavailable');
    } finally {
        await client.close();
    }
});
