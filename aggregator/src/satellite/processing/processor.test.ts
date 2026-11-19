import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SatelliteProcessor } from './processor.js';
import { CFG, DAY0, detFrame, genStream, retFrame, toEntries, type Det, updFrame } from './testSupport.js';

test('stream generator exercises fires, splits, retractions and late detections', async () => {
    const frames = genStream(3);
    const proc = new SatelliteProcessor({ ...CFG, evict_every_offsets: 0 });
    toEntries(frames).forEach((e) => proc.apply(e.offset, e.kind, e.raw));
    assert.ok(proc.index.fires().length >= 3, 'has fires');
    assert.ok(proc.counters.retracts > 0);
    assert.ok(proc.counters.lateDetections >= 3, 'late detections found');
    assert.ok(proc.index.filteredLowCount > 0);
    assert.ok(proc.counters.updates > 0);
});

test('processor: late detections are reported and excluded, heartbeats move the watermark', () => {
    const p = new SatelliteProcessor(CFG);
    const hb = (o: number, min: number): void => void p.apply(o, 'heartbeat', JSON.stringify({ offset: o, virtual_now: new Date(DAY0 + min * 60_000).toISOString() }));
    hb(0, 1000);
    assert.equal(p.watermarkMs, DAY0 + 1000 * 60_000);
    const late: Det = { sat: 'N', min: 1000 - 361, lat: 1, lon: 100, conf: 'n', frp: 1 };
    const ok: Det = { sat: 'N', min: 1000 - 360, lat: 1.001, lon: 100, conf: 'n', frp: 1 };
    const rl = p.apply(1, 'detection', detFrame(late).make(1));
    assert.equal(rl.late?.behind_ms, 361 * 60_000);
    assert.equal(p.apply(2, 'detection', detFrame(ok).make(2)).late, undefined);
    assert.equal(p.counters.lateDetections, 1);
    assert.equal(p.index.size, 1);
});

test('processor: a retracted key stays retracted when the feed re-sends it', () => {
    const p = new SatelliteProcessor(CFG);
    const a: Det = { sat: 'N', min: 10, lat: 1, lon: 100, conf: 'n', frp: 1 };
    const b: Det = { sat: 'N', min: 12, lat: 1.002, lon: 100, conf: 'n', frp: 1 };
    p.apply(0, 'detection', detFrame(a).make(0));
    p.apply(1, 'detection', detFrame(b).make(1));
    assert.equal(p.index.fires().length, 1);
    p.apply(2, 'retract', retFrame(b).make(2));
    assert.equal(p.index.fires().length, 0);
    p.apply(3, 'detection', detFrame(b).make(3));
    assert.equal(p.index.fires().length, 0);
    assert.equal(p.counters.ignoredRetracted, 1);
});

test('processor: an update or retract for an unknown key is counted, not applied', () => {
    const p = new SatelliteProcessor(CFG);
    const ghost: Det = { sat: 'N', min: 10, lat: 1, lon: 100, conf: 'n', frp: 1 };
    p.apply(0, 'update', updFrame(ghost, { frp: 3 }).make(0));
    p.apply(1, 'retract', retFrame(ghost).make(1));
    assert.equal(p.counters.unknownCorrections, 2);
    p.apply(2, 'detection', detFrame(ghost).make(2));
    assert.equal(p.index.size, 0, 'a retract tombstone keeps the later detection out');
});

test('processor: the same frames give the same state however often they are replayed', () => {
    const frames = toEntries(genStream(11));
    const a = new SatelliteProcessor(CFG);
    const b = new SatelliteProcessor(CFG);
    frames.forEach((e) => a.apply(e.offset, e.kind, e.raw));
    frames.forEach((e) => b.apply(e.offset, e.kind, e.raw));
    assert.deepEqual(a.index.fires(), b.index.fires());
    assert.deepEqual(a.counters, b.counters);
    assert.equal(a.watermarkMs, b.watermarkMs);
});
