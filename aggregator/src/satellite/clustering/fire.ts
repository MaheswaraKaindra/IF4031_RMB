import { createHash } from 'node:crypto';
import type { Confidence, Detection } from './detection.js';

export interface Fire {
    fire_id: string;
    detection_count: number;
    satellites: string[];
    max_confidence: Confidence;
    total_frp_mw: number;
    latitude: number;
    longitude: number;
    occurred_ms: number;
    severity: 'WASPADA' | 'SIAGA' | 'AWAS';
    detection_keys: string[];
}

export interface FireDelta {
    upserts: Fire[];
    removed: string[]; // fire ids that no longer exist (shrunk below 2, merged away or split off)
}

const CONFIDENCE_RANK: Record<Confidence, number> = { l: 0, n: 1, h: 2 };

export function severityOf(count: number, totalFrp: number): Fire['severity'] {
    if (count >= 20 || totalFrp >= 100) return 'AWAS';
    if (count >= 6 || totalFrp >= 30) return 'SIAGA';
    return 'WASPADA';
}

export function fireIdFor(earliest: Detection): string {
    return `fire-${createHash('sha256').update(earliest.key).digest('hex').slice(0, 10)}`;
}

function byTimeThenKey(a: Detection, b: Detection): number {
    return a.time_ms - b.time_ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function round(v: number, digits: number): number {
    const f = 10 ** digits;
    return Math.round(v * f) / f;
}

export function buildFire(members: Detection[]): Fire {
    const sorted = [...members].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const earliest = [...members].sort(byTimeThenKey)[0]!;
    let frp = 0;
    let lat = 0;
    let lon = 0;
    let best: Confidence = 'l';
    const satellites = new Set<string>();
    for (const d of sorted) {
        frp += d.frp_mw;
        lat += d.latitude;
        lon += d.longitude;
        satellites.add(d.satellite);
        if (CONFIDENCE_RANK[d.confidence] > CONFIDENCE_RANK[best]) best = d.confidence;
    }
    const total = round(frp, 2);
    return {
        fire_id: fireIdFor(earliest),
        detection_count: members.length,
        satellites: [...satellites].sort(),
        max_confidence: best,
        total_frp_mw: total,
        latitude: round(lat / members.length, 5),
        longitude: round(lon / members.length, 5),
        occurred_ms: earliest.time_ms,
        severity: severityOf(members.length, total),
        detection_keys: sorted.map((d) => d.key),
    };
}
