import assert from 'node:assert/strict';
import test from 'node:test';
import { SatelliteProcessor } from './processing/processor.js';
import { computeReference, diffAgainstStored, type LogEntry } from './reference.js';

// Small deterministic generator so a failure can be replayed from its seed.
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function randomLog(seed: number, n: number, spanMinutes: number, backwardsEvery = 0): LogEntry[] {
    const r = rng(seed);
    const entries: LogEntry[] = [];
    const keys: string[] = [];
    for (let o = 0; o < n; o++) {
        const roll = r();
        if (roll < 0.06 && keys.length > 0) {
            const key = keys[Math.floor(r() * keys.length)]!;
            entries.push({ offset: o, kind: 'retract', raw: JSON.stringify({ offset: o, key, reason: 'false_positive' }) });
        } else if (roll < 0.16 && keys.length > 0) {
            const key = keys[Math.floor(r() * keys.length)]!;
            const changes = r() < 0.5 ? { confidence: r() < 0.5 ? 'l' : 'h' } : { frp: Math.round(r() * 400) / 10 };
            entries.push({ offset: o, kind: 'update', raw: JSON.stringify({ offset: o, key, changes }) });
        } else {
            let minute = Math.floor((o / n) * spanMinutes);
            if (backwardsEvery > 0 && o % backwardsEvery === 0) minute = Math.max(0, minute - 900);
            const hh = String(Math.floor(minute / 60) % 24).padStart(2, '0');
            const mm = String(minute % 60).padStart(2, '0');
            const day = 7 + Math.floor(minute / 1440);
            const c = Math.floor(r() * 40); // 40 separate areas, so the log holds many fires that merge, split and stay apart
            const lat = (5 + c * 0.1 + (r() - 0.5) * 0.012).toFixed(5);
            const lon = (96.99 + (c % 7) * 0.1 + (r() - 0.5) * 0.012).toFixed(5);
            const sat = r() < 0.5 ? 'N' : 'N20';
            const conf = r() < 0.15 ? 'l' : r() < 0.3 ? 'h' : 'n';
            const frp = Math.round(r() * 120) / 10;
            const acqTime = `${hh}${mm}`.replace(/^0+(?=\d)/, '');
            const raw = `{"offset":${o},"detection":{"version":"2.0NRT","acq_date":"2026-12-${String(day).padStart(2, '0')}","acq_time":${acqTime},"confidence":"${conf}","frp":${frp},"satellite":"${sat}","latitude":${lat},"longitude":${lon}}}`;
            keys.push(`${sat}|2026-12-${String(day).padStart(2, '0')}|${acqTime}|${lat}|${lon}`);
            entries.push({ offset: o, kind: 'detection', raw });
        }
    }
    return entries;
}

function incremental(entries: LogEntry[], latenessMs: number): Map<string, { count: number; frp: number; severity: string }> {
    const p = new SatelliteProcessor({ lateness_ms: latenessMs, evict_every_offsets: 0 });
    for (const e of entries) p.apply(e.offset, e.kind, e.raw);
    return new Map(p.index.fires().map((f) => [f.fire_id, { count: f.detection_count, frp: f.total_frp_mw, severity: f.severity }]));
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`the batch reference and the incremental pipeline agree on a random log (seed ${seed})`, () => {
        const entries = randomLog(seed, 1500, 600);
        const lateness = 360 * 60_000;
        const ref = computeReference(entries, lateness);
        const inc = incremental(entries, lateness);
        assert.equal(ref.fires.size > 0, true, 'the generator must produce fires');
        assert.deepEqual([...ref.fires.keys()].sort(), [...inc.keys()].sort());
        for (const [id, f] of ref.fires) {
            const i = inc.get(id)!;
            assert.equal(f.detection_count, i.count, id);
            assert.equal(f.severity, i.severity, id);
            assert.equal(Math.abs(f.total_frp_mw - i.frp) < 0.011, true, id);
        }
    });
}

test('late detections are left out by both under the same declared lateness', () => {
    const entries = randomLog(11, 1500, 2400, 7);
    const lateness = 120 * 60_000;
    const ref = computeReference(entries, lateness);
    const inc = incremental(entries, lateness);
    assert.equal(ref.late > 0, true, 'the generator must produce late detections');
    assert.deepEqual([...ref.fires.keys()].sort(), [...inc.keys()].sort());
});

test('a stored record with a wrong count is reported as different, a missing one as missing, an extra one as extra', () => {
    const ref = computeReference(randomLog(1, 1500, 600), 360 * 60_000);
    assert.equal(ref.fires.size >= 3, true, 'the scenario needs several fires');
    const stored = [...ref.fires.values()].map((f) => ({ source_ref_id: f.fire_id, severity: f.severity, attributes: { detection_count: f.detection_count, total_frp_mw: f.total_frp_mw } }));
    assert.equal(diffAgainstStored(ref.fires, stored).ok, true);
    const broken = stored.slice(1);
    broken[0] = { ...broken[0]!, attributes: { detection_count: 999, total_frp_mw: 0 } };
    broken.push({ source_ref_id: 'fire-extra', severity: 'WASPADA', attributes: {} });
    const d = diffAgainstStored(ref.fires, broken);
    assert.equal(d.ok, false);
    assert.equal(d.missing.length, 1);
    assert.equal(d.extra.length, 1);
    assert.equal(d.different.length, 1);
});
