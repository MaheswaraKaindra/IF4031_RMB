import { createHash } from 'node:crypto';
import { parseAcquisitionTime } from './clustering/detection.js';

/**
 * Independent reference for the wildfire clustering. It does not use FireIndex or the processor: it replays the raw feed log
 * into the final set of detections (updates and retractions applied, late detections left out under the same declared lateness),
 * then builds the fires in one batch with union-find over a spatial grid. If this and the incremental pipeline agree on a log,
 * the incremental bookkeeping (transitive merges, splits after a retraction, replay) did not drift from the plain definition:
 *   - two detections are linked when they are at most 1.0 km apart (great circle) and at most 360 minutes apart (inclusive);
 *   - a fire is a connected component with at least 2 detections; low confidence detections are dropped;
 *   - the fire id is the hash of the key of its earliest detection (ties by key).
 */
export interface RefFire {
    fire_id: string;
    detection_count: number;
    total_frp_mw: number;
    severity: 'WASPADA' | 'SIAGA' | 'AWAS';
    satellites: string[];
    max_confidence: 'n' | 'h';
}

export interface RefResult {
    fires: Map<string, RefFire>;
    detections: number; // kept after corrections (all confidences)
    low_confidence: number;
    singletons: number;
    late: number;
    retracted: number;
    invalid: number;
    unknown_corrections: number;
}

interface Det {
    key: string;
    satellite: string;
    t: number;
    lat: number;
    lon: number;
    conf: 'l' | 'n' | 'h';
    frp: number;
}

const R_KM = 6371.0088;
const MAX_KM = 1.0;
const MAX_GAP_MS = 360 * 60_000;
const CELL = 0.02;

function distKm(a: Det, b: Det): number {
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function severityFor(count: number, frp: number): RefFire['severity'] {
    if (count >= 20 || frp >= 100) return 'AWAS';
    if (count >= 6 || frp >= 30) return 'SIAGA';
    return 'WASPADA';
}

export interface LogEntry {
    offset: number;
    kind: string;
    raw: string;
}

/** The raw token of the key must come from the text: the feed's coordinates are part of the identity. */
function rawKey(raw: string, d: Record<string, unknown>): string | undefined {
    const lat = /"latitude"\s*:\s*(-?[0-9][0-9.eE+-]*)/.exec(raw)?.[1];
    const lon = /"longitude"\s*:\s*(-?[0-9][0-9.eE+-]*)/.exec(raw)?.[1];
    if (lat === undefined || lon === undefined) return undefined;
    return `${String(d['satellite'])}|${String(d['acq_date'])}|${String(d['acq_time'])}|${lat}|${lon}`;
}

export function computeReference(entries: Iterable<LogEntry>, latenessMs: number): RefResult {
    const dets = new Map<string, Det>();
    const retracted = new Set<string>();
    let watermark = Number.NEGATIVE_INFINITY;
    const out = { late: 0, retractedCount: 0, invalid: 0, unknown: 0 };

    for (const e of entries) {
        let body: Record<string, unknown>;
        try {
            body = JSON.parse(e.raw) as Record<string, unknown>;
        } catch {
            out.invalid += 1;
            continue;
        }
        if (e.kind === 'heartbeat') {
            const vn = typeof body['virtual_now'] === 'string' ? Date.parse(body['virtual_now']) : NaN;
            if (!Number.isNaN(vn) && vn > watermark) watermark = vn;
        } else if (e.kind === 'detection') {
            const d = body['detection'] as Record<string, unknown> | undefined;
            const key = d ? rawKey(e.raw, d) : undefined;
            if (!d || key === undefined || typeof d['latitude'] !== 'number' || typeof d['longitude'] !== 'number' || typeof d['frp'] !== 'number' || typeof d['confidence'] !== 'string' || !['l', 'n', 'h'].includes(d['confidence'])) {
                out.invalid += 1;
                continue;
            }
            let t: number;
            try {
                t = parseAcquisitionTime(String(d['acq_date']), d['acq_time'] as string | number);
            } catch {
                out.invalid += 1;
                continue;
            }
            if (retracted.has(key)) continue;
            if (t < watermark - latenessMs) {
                out.late += 1;
                continue;
            }
            if (t > watermark) watermark = t;
            dets.set(key, { key, satellite: String(d['satellite']), t, lat: d['latitude'], lon: d['longitude'], conf: d['confidence'] as Det['conf'], frp: d['frp'] });
        } else if (e.kind === 'update') {
            const cur = typeof body['key'] === 'string' ? dets.get(body['key']) : undefined;
            if (!cur) {
                out.unknown += 1;
                continue;
            }
            const ch = (body['changes'] ?? {}) as Record<string, unknown>;
            if (typeof ch['confidence'] === 'string' && ['l', 'n', 'h'].includes(ch['confidence'])) cur.conf = ch['confidence'] as Det['conf'];
            if (typeof ch['frp'] === 'number') cur.frp = ch['frp'];
        } else if (e.kind === 'retract') {
            if (typeof body['key'] !== 'string') {
                out.invalid += 1;
                continue;
            }
            retracted.add(body['key']);
            out.retractedCount += 1;
            if (!dets.delete(body['key'])) out.unknown += 1;
        }
    }

    const kept = [...dets.values()].filter((d) => d.conf !== 'l');
    const low = dets.size - kept.length;

    // Union-find over a grid: a pair can only be within 1 km when the cells are adjacent.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
        let r = k;
        while (parent.get(r) !== r) r = parent.get(r)!;
        for (let c = k; c !== r; ) {
            const n = parent.get(c)!;
            parent.set(c, r);
            c = n;
        }
        return r;
    };
    const grid = new Map<string, Det[]>();
    for (const d of kept) {
        parent.set(d.key, d.key);
        const id = `${Math.floor(d.lat / CELL)}:${Math.floor(d.lon / CELL)}`;
        const bucket = grid.get(id);
        if (bucket) bucket.push(d);
        else grid.set(id, [d]);
    }
    for (const d of kept) {
        const ci = Math.floor(d.lat / CELL);
        const cj = Math.floor(d.lon / CELL);
        for (let i = ci - 1; i <= ci + 1; i++) {
            for (let j = cj - 1; j <= cj + 1; j++) {
                for (const o of grid.get(`${i}:${j}`) ?? []) {
                    if (o.key <= d.key) continue;
                    if (Math.abs(o.t - d.t) > MAX_GAP_MS) continue;
                    if (distKm(d, o) > MAX_KM) continue;
                    const a = find(d.key);
                    const b = find(o.key);
                    if (a !== b) parent.set(a, b);
                }
            }
        }
    }
    const groups = new Map<string, Det[]>();
    for (const d of kept) {
        const r = find(d.key);
        const g = groups.get(r);
        if (g) g.push(d);
        else groups.set(r, [d]);
    }
    const fires = new Map<string, RefFire>();
    let singletons = 0;
    for (const members of groups.values()) {
        if (members.length < 2) {
            singletons += 1;
            continue;
        }
        const earliest = [...members].sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0]!;
        const id = `fire-${createHash('sha256').update(earliest.key).digest('hex').slice(0, 10)}`;
        const frp = Math.round(members.reduce((s, m) => s + m.frp, 0) * 100) / 100;
        fires.set(id, {
            fire_id: id,
            detection_count: members.length,
            total_frp_mw: frp,
            severity: severityFor(members.length, frp),
            satellites: [...new Set(members.map((m) => m.satellite))].sort(),
            max_confidence: members.some((m) => m.conf === 'h') ? 'h' : 'n',
        });
    }
    return { fires, detections: dets.size, low_confidence: low, singletons, late: out.late, retracted: out.retractedCount, invalid: out.invalid, unknown_corrections: out.unknown };
}

export interface RefDiff {
    ok: boolean;
    missing: string[];
    extra: string[];
    different: Array<{ fire_id: string; reference: Pick<RefFire, 'detection_count' | 'severity' | 'total_frp_mw'>; stored: Record<string, unknown> }>;
}

/** Compares the reference with stored WILDFIRE records; ids in `skip` (touched by frames that are still in flight) are ignored. */
export function diffAgainstStored(
    ref: Map<string, RefFire>,
    stored: Array<{ source_ref_id: string; severity: string; attributes?: Record<string, unknown> }>,
    skip: ReadonlySet<string> = new Set()
): RefDiff {
    const storedById = new Map(stored.map((s) => [s.source_ref_id, s]));
    const missing: string[] = [];
    const extra: string[] = [];
    const different: RefDiff['different'] = [];
    for (const [id, f] of ref) {
        if (skip.has(id)) continue;
        const s = storedById.get(id);
        if (!s) {
            missing.push(id);
            continue;
        }
        const a = s.attributes ?? {};
        const frpOk = typeof a['total_frp_mw'] === 'number' && Math.abs((a['total_frp_mw'] as number) - f.total_frp_mw) < 0.011;
        if (a['detection_count'] !== f.detection_count || s.severity !== f.severity || !frpOk) {
            different.push({ fire_id: id, reference: { detection_count: f.detection_count, severity: f.severity, total_frp_mw: f.total_frp_mw }, stored: { detection_count: a['detection_count'], severity: s.severity, total_frp_mw: a['total_frp_mw'] } });
        }
    }
    for (const id of storedById.keys()) if (!ref.has(id) && !skip.has(id)) extra.push(id);
    return { ok: missing.length + extra.length + different.length === 0, missing, extra, different };
}
