import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentSignature, observationToHazard, validateObservation, validateStation, type Station } from './contract.js';
import { SensorFreshness } from './freshness.js';

const padang: Station = { station_id: 'stn-padang-01', name: 'Padang', province: 'Sumatera Barat', latitude: -0.9492, longitude: 100.3543 };
const stations = new Map([[padang.station_id, padang]]);
const good = {
    observation_id: 'obs-1',
    station_id: 'stn-padang-01',
    observed_at: '2026-11-12T00:30:00Z',
    sea_level_anomaly_m: 1.46,
    wave_height_m: 1.11,
    quality: 'ok',
    critical: true,
};
const reasonOf = (raw: unknown, gen?: number): string => {
    const v = validateObservation(raw, stations, gen);
    return v.ok ? 'ok' : v.reason;
};

test('a well formed observation validates, integers are numbers', () => {
    assert.equal(reasonOf(good), 'ok');
    assert.equal(reasonOf({ ...good, sea_level_anomaly_m: 0, wave_height_m: 2 }), 'ok');
    assert.equal(reasonOf({ ...good, quality: 'suspect' }), 'ok');
});

test('contract violations are rejected with a reason', () => {
    assert.equal(reasonOf(null), 'not_an_object');
    assert.equal(reasonOf([]), 'not_an_object');
    assert.equal(reasonOf({ ...good, observation_id: undefined }), 'missing_field:observation_id');
    assert.equal(reasonOf({ ...good, wave_height_m: null }), 'missing_field:wave_height_m');
    assert.equal(reasonOf({ ...good, wave_height_m: '1.1' }), 'bad_type:wave_height_m');
    assert.equal(reasonOf({ ...good, sea_level_anomaly_m: NaN }), 'bad_type:sea_level_anomaly_m');
    assert.equal(reasonOf({ ...good, critical: 'true' }), 'bad_type:critical');
    assert.equal(reasonOf({ ...good, observed_at: '12 Nov 2026' }), 'bad_observed_at');
    assert.equal(reasonOf({ ...good, observed_at: '2026-13-45T00:00:00Z' }), 'bad_observed_at');
    assert.equal(reasonOf({ ...good, observed_at: '2026-11-12T00:30:00+07:00' }), 'bad_observed_at');
    assert.equal(reasonOf({ ...good, station_id: 'stn-ghost-99' }), 'unknown_station');
    assert.equal(reasonOf({ ...good, sea_level_anomaly_m: 999 }), 'out_of_range:sea_level_anomaly_m');
    assert.equal(reasonOf({ ...good, wave_height_m: -1 }), 'out_of_range:wave_height_m');
    assert.equal(reasonOf({ ...good, wave_height_m: 400 }), 'out_of_range:wave_height_m');
});

test('an observation from after the sensor generated the response is rejected', () => {
    const gen = Date.parse('2026-11-12T00:00:00Z');
    assert.equal(reasonOf(good, gen), 'observed_after_generated');
    assert.equal(reasonOf(good, Date.parse('2026-11-12T00:31:00Z')), 'ok');
});

test('station validation rejects bad coordinates and empty province', () => {
    assert.ok(validateStation({ ...padang }));
    assert.equal(validateStation({ ...padang, latitude: 91 }), null);
    assert.equal(validateStation({ ...padang, province: '' }), null);
    assert.equal(validateStation('x'), null);
});

test('mapping: critical flag drives severity, the flag is stored explicitly, id is stable', () => {
    const v = validateObservation(good, stations);
    assert.ok(v.ok);
    const rec = observationToHazard(v.observation, padang, { ingestedAt: '2026-11-19T00:00:00Z' });
    assert.equal(rec.hazard_type, 'COASTAL');
    assert.equal(rec.source, 'SENSOR_PANTAI');
    assert.equal(rec.severity, 'AWAS');
    assert.equal(rec.area_name, 'Sumatera Barat');
    assert.equal(rec.occurred_at, '2026-11-12T00:30:00.000Z');
    assert.equal(rec.attributes['critical'], true);
    const again = observationToHazard(v.observation, padang, { ingestedAt: 'later' });
    assert.equal(again.hazard_id, rec.hazard_id);
    const calm = validateObservation({ ...good, observation_id: 'obs-2', critical: false }, stations);
    assert.ok(calm.ok);
    assert.equal(observationToHazard(calm.observation, padang, { ingestedAt: 'x' }).severity, 'WASPADA');
});

test('content signature differs only when the content differs', () => {
    const a = validateObservation(good, stations);
    const b = validateObservation({ ...good, wave_height_m: 1.12 }, stations);
    assert.ok(a.ok && b.ok);
    assert.equal(contentSignature(a.observation), contentSignature(a.observation));
    assert.notEqual(contentSignature(a.observation), contentSignature(b.observation));
});

const T0 = Date.parse('2026-11-12T01:00:00Z');

test('freshness: a normal lag is fresh, a growing lag is stale even though healthz would say ok', () => {
    const f = new SensorFreshness(undefined, () => ['stn-padang-01']);
    f.recordObservation('stn-padang-01', T0);
    assert.equal(f.evaluate(T0 + 10_000, true, 1_000).health, 'fresh');
    const r = f.evaluate(T0 + 3_600_000, true, 2_000);
    assert.equal(r.health, 'stale');
    assert.equal(r.lagMs, 3_600_000);
});

test('freshness: a catch-up page is not judged', () => {
    const f = new SensorFreshness();
    f.recordObservation('a', T0);
    assert.equal(f.evaluate(T0 + 3_600_000, false, 0).health, 'fresh');
});

test('freshness: generated_at that stops advancing is a frozen clock', () => {
    const f = new SensorFreshness();
    f.recordObservation('a', T0);
    assert.equal(f.evaluate(T0 + 5_000, true, 0).health, 'fresh');
    assert.equal(f.evaluate(T0 + 5_000, true, 3_000).health, 'fresh');
    assert.equal(f.evaluate(T0 + 5_000, true, 5_000).health, 'frozen_clock');
    assert.equal(f.evaluate(T0 + 6_000, true, 6_000).health, 'fresh');
});

test('freshness: a silent station is reported without making the source stale', () => {
    const f = new SensorFreshness(undefined, () => ['a', 'b']);
    f.recordObservation('a', T0);
    f.recordObservation('b', T0 - 600_000);
    f.recordObservation('a', T0 + 60_000);
    const r = f.evaluate(T0 + 70_000, true, 0);
    assert.equal(r.health, 'fresh');
    assert.deepEqual(r.silentStations, ['b']);
});
