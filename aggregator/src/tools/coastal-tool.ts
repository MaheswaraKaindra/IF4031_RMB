// P5 measurement tool. Read-only against the live store; compares it with an independent crawl of the sensor.
//   node --import tsx src/tools/coastal-tool.ts verify [--db bnpb_canonical_store] [--deadline 5000] [--out report.json]
//   node --import tsx src/tools/coastal-tool.ts report [--db bnpb_canonical_store] [--deadline 5000]
//   node --import tsx src/tools/coastal-tool.ts synthetic [--n 200] [--rate 50] [--wait 60] [--deadline 5000]   inject critical deliveries into the ledger and measure them
//   node --import tsx src/tools/coastal-tool.ts emit --n 750 --rate 5 --out emitted.json   enqueue critical observations into the fake sensor, record emission times
//   node --import tsx src/tools/coastal-tool.ts latency --emitted emitted.json [--deadline 5000]   end-to-end latency: from emission at the sensor to the receiver's acknowledgement
// Env: MONGO_URI, SENSOR_PANTAI_URL (default http://127.0.0.1:18080), PANTAI_AUTH_TOKEN.
import { readFileSync, writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { contentSignature, validateObservation, validateStation, type Station } from '../coastal/contract.js';
import { deliveryKey, MongoDeliveryLedger, summarize, type DeliveryEntry } from '../coastal/ledger.js';
import { COASTAL_PARTITION, COASTAL_SOURCE } from '../coastal/poller.js';
import { hazardIdFor } from '../storage/identity.js';

function flag(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const next = i === -1 ? undefined : process.argv[i + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
}

async function get(base: string, token: string, path: string): Promise<any> {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
}

function offsetOf(cursor: string | undefined): number | null {
    if (!cursor) return null;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
        return Number.isInteger(o) ? o : null;
    } catch {
        return null;
    }
}

// Emission side of the end-to-end measurement against the fake sensor: ids and emission times, kept on this machine's clock.
async function emit(): Promise<void> {
    const n = Number(flag('n', '750'));
    const rate = Number(flag('rate', '5'));
    const base = (flag('sensor', process.env.FAKE_SENSOR_URL || 'http://127.0.0.1:18084')).replace(/\/$/, '');
    const token = process.env.PANTAI_AUTH_TOKEN ?? '';
    const run = Date.now().toString(36);
    const out: Record<string, number> = {};
    let skipped = 0;
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
        const id = `fk-c-${run}-${i}`;
        const item = { observation_id: id, station_id: 'stn-padang-01', observed_at: '2026-11-12T00:10:00Z', sea_level_anomaly_m: 1.4, wave_height_m: 2.1, quality: 'ok', critical: true };
        const at = Date.now();
        try {
            const res = await fetch(`${base}/admin/enqueue`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ items: [item] }), signal: AbortSignal.timeout(2000) });
            if (res.ok) out[hazardIdFor('SENSOR_PANTAI', id)] = at;
            else skipped++;
        } catch {
            skipped++;
        }
        const due = t0 + ((i + 1) * 1000) / rate;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
    }
    const file = flag('out', '');
    if (file) writeFileSync(file, JSON.stringify(out));
    console.log(JSON.stringify({ run, emitted: Object.keys(out).length, skipped }));
}

async function main(): Promise<void> {
    if (process.argv[2] === 'emit') return emit();
    const cmd = process.argv[2];
    const dbName = flag('db', 'bnpb_canonical_store');
    const deadline = Number(flag('deadline', '5000'));
    const client = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27018');
    await client.connect();
    const db = client.db(dbName);
    try {
        if (cmd === 'report') {
            const entries = (await db.collection('coastal_deliveries').find({}, { projection: { event: 0 } }).toArray()) as unknown as DeliveryEntry[];
            console.log(JSON.stringify(summarize(entries, deadline, Date.now()), null, 2));
        } else if (cmd === 'synthetic') {
            await synthetic(db, deadline);
        } else if (cmd === 'verify') {
            await verify(db, deadline);
        } else if (cmd === 'latency') {
            await latency(db, deadline);
        } else {
            console.error('usage: coastal-tool.ts verify|report');
            process.exitCode = 2;
        }
    } finally {
        await client.close();
    }
}

// End-to-end latency from the emission times written by `emit` (this machine's clock) to the receiver's acknowledgement recorded in
// the ledger (the store's clock). The offset between the two clocks is measured against the store and subtracted, so the figure
// includes the poll interval, the sensor-to-aggregator hop, the publish and the consumer, not just the time inside the aggregator.
async function latency(db: ReturnType<MongoClient['db']>, deadline: number): Promise<void> {
    const file = flag('emitted', '');
    if (!file) throw new Error('--emitted <file written by emit> is required');
    const emitted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
    let offset = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const hello = (await db.admin().command({ isMaster: 1 })) as { localTime?: Date };
        const t1 = Date.now();
        if (hello.localTime) {
            const est = hello.localTime.getTime() - (t0 + t1) / 2;
            if (Math.abs(est) < Math.abs(offset)) offset = est;
        }
    }
    if (!Number.isFinite(offset)) offset = 0;
    const ids = Object.keys(emitted);
    const entries = (await db.collection('coastal_deliveries').find({ hazard_id: { $in: ids } }, { projection: { event: 0 } }).toArray()) as unknown as DeliveryEntry[];
    const byId = new Map(entries.map((e) => [e.hazard_id, e]));
    const lat: number[] = [];
    let notInLedger = 0;
    let notDelivered = 0;
    for (const id of ids) {
        const e = byId.get(id);
        if (!e) notInLedger++;
        else if (!e.delivered_at) notDelivered++;
        else lat.push(e.delivered_at.getTime() - (emitted[id]! + offset));
    }
    lat.sort((a, b) => a - b);
    const pct = (p: number): number | null => (lat.length === 0 ? null : Math.round(lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)]!));
    const within = lat.filter((v) => v <= deadline).length;
    const result = {
        emitted: ids.length,
        delivered: lat.length,
        not_in_ledger: notInLedger,
        not_delivered: notDelivered,
        within_deadline: within,
        deadline_ms: deadline,
        deadline_misses: ids.length - within,
        p50_ms: pct(0.5),
        p95_ms: pct(0.95),
        max_ms: lat.length ? Math.round(lat[lat.length - 1]!) : null,
        clock_offset_ms: Math.round(offset),
    };
    console.log(JSON.stringify(result, null, 2));
    if (notInLedger + notDelivered > 0 || result.deadline_misses > 0) process.exitCode = 1;
}

async function verify(db: ReturnType<MongoClient['db']>, deadline: number): Promise<void> {
    const base = (process.env.SENSOR_PANTAI_URL || 'http://127.0.0.1:18080').replace(/\/$/, '');
    const token = process.env.PANTAI_AUTH_TOKEN;
    if (!token) throw new Error('PANTAI_AUTH_TOKEN is required');

    const cp = await db.collection('source_checkpoints').findOne({ _id: `${COASTAL_SOURCE}:${COASTAL_PARTITION}` as never });
    const committed = (cp as { committed_offset?: string } | null)?.committed_offset;
    const limitOffset = offsetOf(committed);

    const stations = new Map<string, Station>();
    for (const raw of (await get(base, token, '/v1/stations')).items ?? []) {
        const s = validateStation(raw);
        if (s) stations.set(s.station_id, s);
    }

    const expectedValid = new Map<string, string>();
    const expectedCritical = new Set<string>();
    const reasons = new Map<string, number>();
    let seen = 0;
    let conflicts = 0;
    let cursor: string | undefined;
    crawl: for (;;) {
        const page = await get(base, token, `/v1/observations?limit=500${cursor ? `&cursor=${cursor}` : ''}`);
        const gen = Date.parse(page.generated_at);
        for (const raw of page.items ?? []) {
            if (limitOffset !== null && seen >= limitOffset) break crawl;
            seen++;
            const v = validateObservation(raw, stations, gen);
            if (!v.ok) {
                const k = v.reason.split(':')[0]!;
                reasons.set(k, (reasons.get(k) ?? 0) + 1);
                continue;
            }
            const sig = contentSignature(v.observation);
            const known = expectedValid.get(v.observation.observation_id);
            if (known !== undefined && known !== sig) {
                conflicts++;
                continue;
            }
            expectedValid.set(v.observation.observation_id, sig);
            if (v.observation.critical) expectedCritical.add(v.observation.observation_id);
        }
        if (!page.next_cursor || !(page.items ?? []).length) break;
        cursor = page.next_cursor;
    }

    const stored = await db.collection('hazards').countDocuments({ source: 'SENSOR_PANTAI' });
    const ids = [...expectedValid.keys()].map((o) => hazardIdFor('SENSOR_PANTAI', o));
    let missing = 0;
    for (let i = 0; i < ids.length; i += 1000) {
        const found = await db.collection('hazards').countDocuments({ hazard_id: { $in: ids.slice(i, i + 1000) } });
        missing += ids.slice(i, i + 1000).length - found;
    }
    const ledger = (await db.collection('coastal_deliveries').find({ _id: { $not: /^hz-synth-/ }, 'event.source_ref_id': { $not: /^(fk-|burst-)/ } } as never, { projection: { event: 0 } }).toArray()) as unknown as DeliveryEntry[];
    const byKey = new Map(ledger.map((e) => [e._id, e]));
    const critMissingFromLedger = [...expectedCritical].filter((o) => !byKey.has(deliveryKey(hazardIdFor('SENSOR_PANTAI', o))));
    const critDelivered = [...expectedCritical].filter((o) => byKey.get(deliveryKey(hazardIdFor('SENSOR_PANTAI', o)))?.delivered_at).length;
    const quarantined = await db.collection('raw_inbox').countDocuments({ source: 'SENSOR_PANTAI' });
    const inLedgerButNotCritical = ledger.filter((e) => !expectedCritical.has(e.event?.source_ref_id ?? '') && e.event).length;

    const report = {
        checked_through_offset: limitOffset ?? 'tail',
        sensor_items_seen: seen,
        expected_valid_unique: expectedValid.size,
        stored_sensor_hazards: stored,
        valid_missing_from_store: missing,
        sensor_contract_violations: Object.fromEntries(reasons),
        conflicting_duplicates: conflicts,
        quarantined_in_inbox: quarantined,
        critical_expected: expectedCritical.size,
        critical_missing_from_ledger: critMissingFromLedger.length,
        critical_delivered: critDelivered,
        critical_loss: expectedCritical.size - critDelivered,
        delivery: summarize(ledger, deadline, Date.now()),
        ledger_entries_not_critical: inLedgerButNotCritical,
    };
    console.log(JSON.stringify(report, null, 2));
    const out = flag('out', '');
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    if (report.valid_missing_from_store > 0 || report.critical_missing_from_ledger > 0) process.exitCode = 1;
}

// Synthetic entries share the real delivery path (relay, broker, notifier, receipt) but never touch the canonical store.
async function synthetic(db: ReturnType<MongoClient['db']>, deadline: number): Promise<void> {
    const n = Number(flag('n', '200'));
    const rate = Number(flag('rate', '50'));
    const waitS = Number(flag('wait', '60'));
    const run = Date.now().toString(36);
    const ledger = new MongoDeliveryLedger(() => db);
    const coll = db.collection('coastal_deliveries');
    const ids: string[] = [];
    let stalls = 0;
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
        const hazardId = `hz-synth-${run}-${i}`;
        const event = {
            hazard_id: hazardId,
            source: 'SENSOR_PANTAI' as const,
            source_ref_id: `synthetic-${run}-${i}`,
            hazard_type: 'COASTAL' as const,
            severity: 'AWAS' as const,
            area_name: 'Synthetic',
            latitude: 0,
            longitude: 0,
            occurred_at: new Date().toISOString(),
            ingested_at: new Date().toISOString(),
            attributes: { synthetic: true, critical: true },
        };
        // The injector retries through a store outage, like the adapter does by holding its cursor.
        for (;;) {
            try {
                const { id } = await ledger.register(event);
                await ledger.markCanonicalApplied(id);
                ids.push(id);
                break;
            } catch {
                stalls++;
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        const due = t0 + ((i + 1) * 1000) / rate;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
    }
    const stop = Date.now() + waitS * 1000;
    let entries: DeliveryEntry[] = [];
    do {
        try {
            entries = (await coll.find({ _id: { $in: ids } } as never, { projection: { event: 0 } }).toArray()) as unknown as DeliveryEntry[];
            if (entries.length === ids.length && entries.every((e) => e.delivered_at)) break;
        } catch {
            stalls++;
        }
        await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < stop);
    const report = { run, injected: n, rate_per_s: rate, ...summarize(entries, deadline, Date.now()), max_attempts: Math.max(0, ...entries.map((e) => e.attempts)), injector_retries: stalls };
    console.log(JSON.stringify(report, null, 2));
    if (report.undelivered > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
