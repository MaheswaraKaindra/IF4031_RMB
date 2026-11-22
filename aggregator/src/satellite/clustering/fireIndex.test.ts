import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFire, severityOf } from './fire.js';
import { parseAcquisitionTime, type Confidence, type Detection } from './detection.js';
import { FireIndex, MAX_GAP_MS } from './fireIndex.js';

const BASE_LAT = -2.5;
const BASE_LON = 113.8;
const KM_LAT = 1 / 111.19;
const T0 = parseAcquisitionTime('2026-11-12', '0200');

function det(id: string, northKm: number, minutes: number, over: Partial<Detection> = {}): Detection {
    const latitude = BASE_LAT + northKm * KM_LAT;
    const longitude = BASE_LON;
    return {
        key: `N20|2026-11-12|${id}|${latitude}|${longitude}`,
        satellite: 'N20',
        time_ms: T0 + minutes * 60_000,
        latitude,
        longitude,
        confidence: 'n',
        frp_mw: 2,
        ...over,
    };
}

function ids(index: FireIndex): string[] {
    return index.fires().map((f) => f.fire_id);
}

test('acquisition time pads HHMM and reads UTC', () => {
    assert.equal(new Date(parseAcquisitionTime('2026-11-12', 243)).toISOString(), '2026-11-12T02:43:00.000Z');
    assert.equal(new Date(parseAcquisitionTime('2026-11-12', '1405')).toISOString(), '2026-11-12T14:05:00.000Z');
});

test('a single detection is not a fire but is counted', () => {
    const idx = new FireIndex();
    const delta = idx.upsert(det('a', 0, 0));
    assert.deepEqual(delta, { upserts: [], removed: [] });
    assert.equal(idx.singletonCount, 1);
    assert.equal(idx.fires().length, 0);
});

test('low confidence is excluded and counted separately', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    idx.upsert(det('b', 0.5, 1, { confidence: 'l' }));
    assert.equal(idx.fires().length, 0);
    assert.equal(idx.filteredLowCount, 1);
    assert.equal(idx.size, 1);
});

test('a low-confidence detection kept aside joins the fire when an update raises its confidence', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    const b = det('b', 0.5, 0, { confidence: 'l' });
    idx.upsert(b);
    assert.equal(idx.fires().length, 0);
    assert.equal(idx.find(b.key)?.confidence, 'l');
    const delta = idx.upsert({ ...b, confidence: 'n' });
    assert.equal(idx.fires().length, 1);
    assert.equal(delta.upserts[0]!.detection_count, 2);
    assert.equal(idx.lowCount, 0);
});

test('eviction drops only components that are entirely older than the cutoff', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    idx.upsert(det('b', 0.5, 10));
    idx.upsert(det('c', 20, 1000));
    idx.upsert(det('d', 20.5, 1005));
    idx.upsert(det('e', 50, 0));
    idx.upsert(det('f', 80, 5, { confidence: 'l' }));
    const res = idx.evictFinalized(T0 + 500 * 60_000);
    assert.deepEqual(res, { fires: 1, detections: 3 });
    assert.equal(idx.fires().length, 1);
    assert.equal(idx.fires()[0]!.detection_count, 2);
    assert.equal(idx.lowCount, 0);
});

test('distance bound is 1 km and time bound is 360 minutes, both inclusive', () => {
    const near = new FireIndex();
    near.upsert(det('a', 0, 0));
    near.upsert(det('b', 0.99, 0));
    assert.equal(near.fires().length, 1);

    const far = new FireIndex();
    far.upsert(det('a', 0, 0));
    far.upsert(det('b', 1.05, 0));
    assert.equal(far.fires().length, 0);

    const edge = new FireIndex();
    edge.upsert(det('a', 0, 0));
    edge.upsert(det('b', 0.5, MAX_GAP_MS / 60_000));
    assert.equal(edge.fires().length, 1);

    const late = new FireIndex();
    late.upsert(det('a', 0, 0));
    late.upsert(det('b', 0.5, MAX_GAP_MS / 60_000 + 1));
    assert.equal(late.fires().length, 0);
});

test('connectivity is transitive: A-B and B-C form one fire although A-C are not adjacent', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    idx.upsert(det('b', 0.9, 0));
    idx.upsert(det('c', 1.8, 0));
    const [fire] = idx.fires();
    assert.equal(idx.fires().length, 1);
    assert.equal(fire!.detection_count, 3);
});

test('the 360 minute rule is per edge, so a chain may span more than 360 minutes in total', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    idx.upsert(det('b', 0.4, 300));
    idx.upsert(det('c', 0.8, 600));
    assert.equal(idx.fires().length, 1);
    assert.equal(idx.fires()[0]!.detection_count, 3);
});

test('the same detection key received twice counts once', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    idx.upsert(det('b', 0.5, 0));
    const again = idx.upsert(det('b', 0.5, 0));
    assert.deepEqual(again, { upserts: [], removed: [] });
    assert.equal(idx.fires()[0]!.detection_count, 2);
});

test('two satellites seeing the same fire produce one fire', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0, { satellite: 'N20', key: 'N20|k1' }));
    idx.upsert(det('b', 0.3, 20, { satellite: 'N21', key: 'N21|k2' }));
    assert.equal(idx.fires().length, 1);
    assert.deepEqual(idx.fires()[0]!.satellites, ['N20', 'N21']);
});

test('retracting the bridge splits one fire into two singletons and removes the fire', () => {
    const idx = new FireIndex();
    const a = det('a', 0, 0);
    const b = det('b', 0.9, 0);
    const c = det('c', 1.8, 0);
    for (const d of [a, b, c]) idx.upsert(d);
    const before = ids(idx);
    const delta = idx.retract(b.key);
    assert.equal(idx.fires().length, 0);
    assert.deepEqual(delta.removed, before);
    assert.equal(idx.singletonCount, 2);
});

test('retracting an end detection shrinks the fire in place and keeps its identity when the earliest stays', () => {
    const idx = new FireIndex();
    const a = det('a', 0, 0);
    const b = det('b', 0.9, 5);
    const c = det('c', 1.8, 10);
    for (const d of [a, b, c]) idx.upsert(d);
    const id = ids(idx)[0]!;
    const delta = idx.retract(c.key);
    assert.deepEqual(ids(idx), [id]);
    assert.equal(delta.removed.length, 0);
    assert.equal(delta.upserts[0]!.detection_count, 2);
});

test('a split gives the earliest-detection part the original identity and the other part a new one', () => {
    const idx = new FireIndex();
    const a = det('a', 0, 0);
    const a2 = det('a2', 0.5, 1);
    const b = det('b', 1.4, 2);
    const c = det('c', 2.3, 3);
    const c2 = det('c2', 2.8, 4);
    for (const d of [a, a2, b, c, c2]) idx.upsert(d);
    assert.equal(idx.fires().length, 1);
    const original = ids(idx)[0]!;
    idx.retract(b.key);
    const after = ids(idx);
    assert.equal(after.length, 2);
    assert.ok(after.includes(original));
});

test('a new detection that bridges two fires merges them into one with the older identity', () => {
    const idx = new FireIndex();
    const left = [det('a', 0, 0), det('a2', 0.5, 1)];
    const right = [det('c', 2.3, 5), det('c2', 2.8, 6)];
    for (const d of [...left, ...right]) idx.upsert(d);
    const [f1, f2] = ids(idx);
    assert.equal(idx.fires().length, 2);
    const delta = idx.upsert(det('b', 1.4, 3));
    assert.equal(idx.fires().length, 1);
    assert.equal(delta.removed.length, 1);
    const survivor = ids(idx)[0]!;
    assert.ok(survivor === f1 || survivor === f2);
    assert.equal(idx.fires()[0]!.fire_id, buildFire([...left, det('b', 1.4, 3), ...right].map((d) => d)).fire_id);
});

test('result is independent of arrival order and of replaying everything twice', () => {
    const all = [det('a', 0, 0), det('b', 0.9, 4), det('c', 1.8, 9), det('d', 5, 0), det('e', 5.5, 2), det('f', 20, 0)];
    const forward = new FireIndex();
    all.forEach((d) => forward.upsert(d));
    const backward = new FireIndex();
    [...all].reverse().forEach((d) => backward.upsert(d));
    const replayed = new FireIndex();
    all.forEach((d) => replayed.upsert(d));
    all.forEach((d) => replayed.upsert(d));
    assert.deepEqual(backward.fires(), forward.fires());
    assert.deepEqual(replayed.fires(), forward.fires());
    assert.equal(forward.fires().length, 2);
    assert.equal(forward.singletonCount, 1);
});

test('retract then re-add restores the same fire as never retracting', () => {
    const clean = new FireIndex();
    const noisy = new FireIndex();
    const all = [det('a', 0, 0), det('b', 0.9, 4), det('c', 1.8, 9)];
    all.forEach((d) => clean.upsert(d));
    all.forEach((d) => noisy.upsert(d));
    noisy.retract(all[1]!.key);
    noisy.upsert(all[1]!);
    assert.deepEqual(noisy.fires(), clean.fires());
});

test('an update that downgrades a detection to low confidence removes it from the fire', () => {
    const idx = new FireIndex();
    const a = det('a', 0, 0);
    const b = det('b', 0.5, 0);
    idx.upsert(a);
    idx.upsert(b);
    const delta = idx.upsert({ ...b, confidence: 'l' as Confidence });
    assert.equal(idx.fires().length, 0);
    assert.equal(delta.removed.length, 1);
});

test('an update that raises FRP changes the fire in place', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 0));
    const b = det('b', 0.5, 0);
    idx.upsert(b);
    const id = ids(idx)[0]!;
    const delta = idx.upsert({ ...b, frp_mw: 40 });
    assert.deepEqual(ids(idx), [id]);
    assert.equal(delta.upserts[0]!.severity, 'SIAGA');
    assert.equal(delta.removed.length, 0);
});

test('severity thresholds follow the specification', () => {
    assert.equal(severityOf(2, 10), 'WASPADA');
    assert.equal(severityOf(6, 10), 'SIAGA');
    assert.equal(severityOf(2, 30), 'SIAGA');
    assert.equal(severityOf(20, 1), 'AWAS');
    assert.equal(severityOf(2, 100), 'AWAS');
});

test('fire attributes: earliest time, sorted keys, summed FRP, max confidence, mean centre', () => {
    const idx = new FireIndex();
    idx.upsert(det('a', 0, 10, { frp_mw: 1.25, confidence: 'n' }));
    idx.upsert(det('b', 0.5, 0, { frp_mw: 2.5, confidence: 'h' }));
    const f = idx.fires()[0]!;
    assert.equal(f.occurred_ms, T0);
    assert.equal(f.total_frp_mw, 3.75);
    assert.equal(f.max_confidence, 'h');
    assert.deepEqual(f.detection_keys, [...f.detection_keys].sort());
    assert.ok(Math.abs(f.latitude - (BASE_LAT + 0.25 * KM_LAT)) < 1e-5);
});
