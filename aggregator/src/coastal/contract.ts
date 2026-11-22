import { createHash } from 'node:crypto';
import { hazardIdFor } from '../storage/identity.js';
import type { HazardRecord } from '../storage/types.js';

export interface Station {
    station_id: string;
    name: string;
    province: string;
    latitude: number;
    longitude: number;
}

export interface Observation {
    observation_id: string;
    station_id: string;
    observed_at: string;
    observed_ms: number;
    sea_level_anomaly_m: number;
    wave_height_m: number;
    quality: string;
    critical: boolean;
}

export type Validation = { ok: true; observation: Observation } | { ok: false; reason: string };

// Physical plausibility bounds, not severity thresholds. The contract states no ranges.
export const SEA_LEVEL_ABS_MAX_M = 30;
export const WAVE_HEIGHT_MAX_M = 40;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parseUtc(value: unknown): number | null {
    if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateStation(raw: unknown): Station | null {
    if (!isRecord(raw)) return null;
    const { station_id, name, province, latitude, longitude } = raw;
    if (typeof station_id !== 'string' || station_id === '') return null;
    if (typeof name !== 'string' || typeof province !== 'string' || province === '') return null;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    return { station_id, name, province, latitude, longitude };
}

export function validateObservation(raw: unknown, stations: ReadonlyMap<string, Station>, generatedMs?: number): Validation {
    if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };
    for (const field of ['observation_id', 'station_id', 'observed_at', 'sea_level_anomaly_m', 'wave_height_m', 'quality', 'critical']) {
        if (!(field in raw) || raw[field] === null || raw[field] === undefined) return { ok: false, reason: `missing_field:${field}` };
    }
    const { observation_id, station_id, observed_at, sea_level_anomaly_m, wave_height_m, quality, critical } = raw;
    if (typeof observation_id !== 'string' || observation_id.trim() === '') return { ok: false, reason: 'bad_type:observation_id' };
    if (typeof station_id !== 'string') return { ok: false, reason: 'bad_type:station_id' };
    if (typeof quality !== 'string' || quality.trim() === '') return { ok: false, reason: 'bad_type:quality' };
    if (typeof critical !== 'boolean') return { ok: false, reason: 'bad_type:critical' };
    if (typeof sea_level_anomaly_m !== 'number' || !Number.isFinite(sea_level_anomaly_m)) return { ok: false, reason: 'bad_type:sea_level_anomaly_m' };
    if (typeof wave_height_m !== 'number' || !Number.isFinite(wave_height_m)) return { ok: false, reason: 'bad_type:wave_height_m' };
    const observedMs = parseUtc(observed_at);
    if (observedMs === null) return { ok: false, reason: 'bad_observed_at' };
    if (!stations.has(station_id)) return { ok: false, reason: 'unknown_station' };
    if (Math.abs(sea_level_anomaly_m) > SEA_LEVEL_ABS_MAX_M) return { ok: false, reason: 'out_of_range:sea_level_anomaly_m' };
    if (wave_height_m < 0 || wave_height_m > WAVE_HEIGHT_MAX_M) return { ok: false, reason: 'out_of_range:wave_height_m' };
    if (generatedMs !== undefined && observedMs > generatedMs + 1_000) return { ok: false, reason: 'observed_after_generated' };
    return {
        ok: true,
        observation: {
            observation_id,
            station_id,
            observed_at: observed_at as string,
            observed_ms: observedMs,
            sea_level_anomaly_m,
            wave_height_m,
            quality,
            critical,
        },
    };
}

export interface MappingContext {
    ingestedAt: string;
    lagMs?: number | undefined;
    // Set when the sensor reuses an observation_id for different content (see CoastalPoller).
    sourceRefId?: string | undefined;
    conflictsWith?: string | undefined;
}

// Proposed mapping: the contract defines no severity thresholds, so the sensor's own critical flag is the only
// signal used. critical=true is AWAS, anything else WASPADA. The flag is also stored verbatim in attributes.
export function observationToHazard(obs: Observation, station: Station, ctx: MappingContext): HazardRecord {
    return {
        hazard_id: hazardIdFor('SENSOR_PANTAI', ctx.sourceRefId ?? obs.observation_id),
        source: 'SENSOR_PANTAI',
        source_ref_id: ctx.sourceRefId ?? obs.observation_id,
        hazard_type: 'COASTAL',
        severity: obs.critical ? 'AWAS' : 'WASPADA',
        area_name: station.province,
        latitude: station.latitude,
        longitude: station.longitude,
        occurred_at: new Date(obs.observed_ms).toISOString(),
        ingested_at: ctx.ingestedAt,
        attributes: {
            station_id: station.station_id,
            station_name: station.name,
            sea_level_anomaly_m: obs.sea_level_anomaly_m,
            wave_height_m: obs.wave_height_m,
            quality: obs.quality,
            critical: obs.critical,
            severity_mapping: 'proposed:critical_flag',
            observation_id: obs.observation_id,
            ...(ctx.conflictsWith !== undefined ? { id_reused_for_different_content: true } : {}),
            ...(ctx.lagMs !== undefined ? { sensor_lag_s: Math.round(ctx.lagMs / 1000) } : {}),
        },
    };
}

export function variantRef(obs: Observation): string {
    return `${obs.observation_id}~${createHash('sha1').update(contentSignature(obs)).digest('hex').slice(0, 8)}`;
}

export function contentSignature(obs: Observation): string {
    return [obs.station_id, obs.observed_at, obs.sea_level_anomaly_m, obs.wave_height_m, obs.quality, obs.critical].join('|');
}
