import assert from 'node:assert/strict';
import test from 'node:test';
import { concentration, generateCatalog, parseCatalog, rowToHazard } from './catalog.js';

test('the generated catalog is deterministic and the size asked for', () => {
    const a = generateCatalog({ count: 3000, seed: 7, days: 365 });
    const b = generateCatalog({ count: 3000, seed: 7, days: 365 });
    assert.equal(a.length, 3000);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, generateCatalog({ count: 3000, seed: 8, days: 365 }));
    assert.equal(new Set(a.map((r) => r.event_id)).size, 3000);
});

test('it imitates real seismicity: many small events, few large, strong spatial concentration, ordered in time', () => {
    const rows = generateCatalog({ count: 20_000, seed: 3, days: 365 });
    const small = rows.filter((r) => r.magnitude < 4.5).length;
    const large = rows.filter((r) => r.magnitude >= 6.5).length;
    assert.equal(small > rows.length * 0.5, true, 'most events are small (Gutenberg-Richter)');
    assert.equal(large > 0 && large < rows.length * 0.02, true, `large events exist but are rare (${large})`);
    const c = concentration(rows);
    assert.equal(c.busiest_cell_share > 0.02, true, `one 1-degree cell holds a visible share (${c.busiest_cell_share}): not uniform`);
    assert.equal(c.provinces >= 8, true, 'events still spread over many provinces');
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i - 1]!.occurred_at <= rows[i]!.occurred_at, true);
    for (const r of rows) assert.equal(r.epicenter_lat >= -16 && r.epicenter_lat <= 8 && r.epicenter_lon >= 90 && r.epicenter_lon <= 145, true);
});

test('rows go through the BMKG mapping and get the same severity rules and identity as fetched events', () => {
    const [row] = parseCatalog('{"id":"x1","time":"2026-03-01T10:00:00Z","lat":-0.9,"lon":100.3,"mag":6.9,"depth":20}');
    const h = rowToHazard(row!);
    assert.equal(h.source, 'BMKG');
    assert.equal(h.hazard_type, 'SEISMIC');
    assert.equal(h.severity, 'SIAGA');
    assert.equal(h.source_ref_id, 'x1');
    assert.equal(h.hazard_id, rowToHazard(row!).hazard_id, 'the id is stable, so loading twice is a no-op');
    assert.equal(h.area_name.length > 0, true);
});

test('CSV and JSON lines with the usual column names are accepted; broken rows are refused with a reason', () => {
    const csv = 'event_id,origin_time,latitude,longitude,mag,depth,place\nA,2026-01-01T00:00:00Z,-1.2,99.8,5.1,30,Padang\nB,2026-01-02T00:00:00Z,5.0,95.0,4.0,10,';
    const rows = parseCatalog(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.region_name, 'Padang');
    assert.equal(rows[1]!.region_name.length > 0, true, 'a missing place is filled from the coordinates');
    assert.throws(() => parseCatalog('{"id":"z","time":"2026-01-01T00:00:00Z","lat":1,"lon":2}'), /no magnitude/);
    assert.throws(() => parseCatalog('{"id":"z","time":"not a time","lat":1,"lon":2,"mag":5}'), /unparsable time/);
});
