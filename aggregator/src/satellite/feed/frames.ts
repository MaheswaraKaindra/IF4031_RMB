import { parseAcquisitionTime, type Confidence, type Detection } from '../clustering/detection.js';
import type { SseFrame } from './sseParser.js';

export type FeedEvent =
    | { kind: 'detection'; offset: number; detection: Detection }
    | { kind: 'update'; offset: number; key: string; changes: Partial<Pick<Detection, 'confidence' | 'frp_mw'>> }
    | { kind: 'retract'; offset: number; key: string; reason: string }
    | { kind: 'heartbeat'; offset: number; virtualNowMs: number | undefined }
    | { kind: 'invalid'; offset: number | undefined; reason: string };

const CONFIDENCES = new Set(['l', 'n', 'h']);

/** Raw numeric token as the feed wrote it: the detection key must not be rebuilt from a rounded double. */
function rawNumberToken(data: string, field: 'latitude' | 'longitude'): string | undefined {
    return new RegExp(`"${field}"\\s*:\\s*(-?[0-9][0-9.eE+-]*)`).exec(data)?.[1];
}

export function decodeFrame(frame: SseFrame): FeedEvent {
    let body: unknown;
    try {
        body = JSON.parse(frame.data);
    } catch {
        return { kind: 'invalid', offset: offsetFromId(frame.id), reason: 'data is not valid JSON' };
    }
    if (typeof body !== 'object' || body === null) return { kind: 'invalid', offset: offsetFromId(frame.id), reason: 'data is not an object' };
    const obj = body as Record<string, unknown>;
    const offset = typeof obj.offset === 'number' && Number.isInteger(obj.offset) ? obj.offset : offsetFromId(frame.id);
    if (offset === undefined) return { kind: 'invalid', offset: undefined, reason: 'missing offset' };

    if (frame.event === 'heartbeat') {
        const vn = typeof obj.virtual_now === 'string' ? Date.parse(obj.virtual_now) : NaN;
        return { kind: 'heartbeat', offset, virtualNowMs: Number.isNaN(vn) ? undefined : vn };
    }
    if (frame.event === 'detection') return decodeDetection(obj, offset, frame.data);
    if (frame.event === 'update') {
        if (typeof obj.key !== 'string' || typeof obj.changes !== 'object' || obj.changes === null) {
            return { kind: 'invalid', offset, reason: 'update without key or changes' };
        }
        const raw = obj.changes as Record<string, unknown>;
        const changes: Partial<Pick<Detection, 'confidence' | 'frp_mw'>> = {};
        if (raw.confidence !== undefined) {
            if (typeof raw.confidence !== 'string' || !CONFIDENCES.has(raw.confidence)) return { kind: 'invalid', offset, reason: 'update with invalid confidence' };
            changes.confidence = raw.confidence as Confidence;
        }
        if (raw.frp !== undefined) {
            if (typeof raw.frp !== 'number' || !Number.isFinite(raw.frp)) return { kind: 'invalid', offset, reason: 'update with invalid frp' };
            changes.frp_mw = raw.frp;
        }
        return { kind: 'update', offset, key: obj.key, changes };
    }
    if (frame.event === 'retract') {
        if (typeof obj.key !== 'string') return { kind: 'invalid', offset, reason: 'retract without key' };
        return { kind: 'retract', offset, key: obj.key, reason: typeof obj.reason === 'string' ? obj.reason : 'unspecified' };
    }
    return { kind: 'invalid', offset, reason: `unknown event type ${frame.event}` };
}

function offsetFromId(id: string | undefined): number | undefined {
    if (id === undefined || !/^\d+$/.test(id)) return undefined;
    return Number(id);
}

function decodeDetection(obj: Record<string, unknown>, offset: number, rawData: string): FeedEvent {
    const d = obj.detection;
    if (typeof d !== 'object' || d === null) return { kind: 'invalid', offset, reason: 'detection payload missing' };
    const r = d as Record<string, unknown>;
    const satellite = r.satellite;
    const acqDate = r.acq_date;
    const acqTime = r.acq_time;
    const lat = r.latitude;
    const lon = r.longitude;
    if (typeof satellite !== 'string' || satellite === '') return { kind: 'invalid', offset, reason: 'detection without satellite' };
    if (typeof acqDate !== 'string' || (typeof acqTime !== 'number' && typeof acqTime !== 'string')) {
        return { kind: 'invalid', offset, reason: 'detection without acquisition time' };
    }
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return { kind: 'invalid', offset, reason: 'detection with invalid coordinates' };
    }
    if (typeof r.confidence !== 'string' || !CONFIDENCES.has(r.confidence)) return { kind: 'invalid', offset, reason: 'detection with invalid confidence' };
    if (typeof r.frp !== 'number' || !Number.isFinite(r.frp)) return { kind: 'invalid', offset, reason: 'detection with invalid frp' };
    let timeMs: number;
    try {
        timeMs = parseAcquisitionTime(acqDate, acqTime);
    } catch {
        return { kind: 'invalid', offset, reason: 'detection with unparsable acquisition time' };
    }
    const latText = rawNumberToken(rawData, 'latitude') ?? String(lat);
    const lonText = rawNumberToken(rawData, 'longitude') ?? String(lon);
    return {
        kind: 'detection',
        offset,
        detection: {
            key: `${satellite}|${acqDate}|${acqTime}|${latText}|${lonText}`,
            satellite,
            time_ms: timeMs,
            latitude: lat,
            longitude: lon,
            confidence: r.confidence as Confidence,
            frp_mw: r.frp,
        },
    };
}
