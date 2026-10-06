import crypto from "crypto";

export interface HazardEvent {
    hazard_id: string;
    source: 'BMKG' | 'PVMBG';
    source_ref_id: string;
    hazard_type: 'SEISMIC' | 'VOLCANIC';
    severity: 'NORMAL' | 'WASPADA' | 'SIAGA' | 'AWAS';
    area_name: string;
    latitude: number;
    longitude: number;
    occurred_at: string;
    ingested_at: string;
    attributes: Record<string, any>;
}

export function recomputeSeverityFromWarning(tsunamiWarning: any): HazardEvent['severity'] {
    const upper = (tsunamiWarning?.threat_level ?? '').toUpperCase() as HazardEvent['severity'];
    const valid: ReadonlyArray<HazardEvent['severity']> = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    return valid.includes(upper) ? upper : 'WASPADA'; // conservative default
}

const SEVERITY_RANK: Record<HazardEvent['severity'], number> = { NORMAL: 0, WASPADA: 1, SIAGA: 2, AWAS: 3 };

export function warningRank(tsunamiWarning: any): number {
    return SEVERITY_RANK[recomputeSeverityFromWarning(tsunamiWarning)];
}

// An event can have several warnings. The spec says AWAS applies when a warning with Awas exists, so the
// strongest one wins, and among equally strong warnings the most recently issued one.
export function pickStrongestWarning(warnings: any[], eventId: string): any | undefined {
    let best: any;
    for (const w of warnings) {
        if (w?.related_event_id !== eventId) continue;
        if (best === undefined) {
            best = w;
            continue;
        }
        const diff = warningRank(w) - warningRank(best);
        if (diff > 0 || (diff === 0 && String(w.issued_at ?? '') > String(best.issued_at ?? ''))) best = w;
    }
    return best;
}

export function mapSeismicToHazard(raw: any, tsunamiWarning?: any): HazardEvent {
    const {
        event_id, magnitude, depth_km, epicenter_lat, epicenter_lon,
        region_name, occurred_at, potential_tsunami,
        ...unknownFields
    } = raw;

    let severity: HazardEvent['severity'] = 'NORMAL';

    if (tsunamiWarning) {
        severity = recomputeSeverityFromWarning(tsunamiWarning);
    } else {
        if (magnitude >= 6.5) severity = 'SIAGA';
        else if (magnitude >= 5.0) severity = 'WASPADA';
    }

    return {
        hazard_id: `HZ-${crypto.randomUUID()}`,
        source: 'BMKG',
        source_ref_id: event_id,
        hazard_type: 'SEISMIC',
        severity,
        area_name: region_name,
        latitude: epicenter_lat,
        longitude: epicenter_lon,
        occurred_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            ...unknownFields,
            magnitude,
            depth_km,
            potential_tsunami,
            ...(tsunamiWarning ? { tsunami_warning: tsunamiWarning } : {}),
        },
    };
}

// alert_level is mapped directly to the canonical enum. A missing or unknown level (for example a new
// enum value) is an unsupported schema change: it throws, so the aggregator skips and logs that one
// record instead of storing an invalid severity.
function severityFromAlertLevel(alertLevel: unknown): HazardEvent['severity'] {
    const upper = typeof alertLevel === 'string' ? alertLevel.toUpperCase() : '';
    const valid: ReadonlyArray<HazardEvent['severity']> = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    if (!valid.includes(upper as HazardEvent['severity'])) {
        throw new Error(`Unsupported alert_level: ${String(alertLevel)}`);
    }
    return upper as HazardEvent['severity'];
}

export function mapVolcanicToHazard(raw: any): HazardEvent {
    // BNPB's static reference table for volcano names and coordinates
    const volcanoDict: Record<string, { name: string; lat: number; lon: number }> = {
        'VOLC-01': { name: 'Mount Prikitiw', lat: -7.542, lon: 110.446 },
        'VOLC-02': { name: 'Mount Skypiea', lat: -8.108, lon: 112.308 },
        'VOLC-03': { name: 'Mount Merapi', lat: -7.541, lon: 110.446 },
        'VOLC-04': { name: 'Mount Semeru', lat: -8.108, lon: 112.922 },
        'VOLC-05': { name: 'Mount Kelud', lat: -7.930, lon: 112.308 },
    };

    const volcanoInfo = volcanoDict[raw.volcano_id] ?? { name: raw.volcano_id, lat: 0, lon: 0 };

    // Spec: every field without a canonical equivalent goes to attributes (rest-spread)
    const {
        report_id, volcano_id, alert_level, reported_at,
        ...unknownFields
    } = raw;

    return {
        hazard_id: `HZ-${crypto.randomUUID()}`,
        source: 'PVMBG',
        source_ref_id: report_id,
        hazard_type: 'VOLCANIC',
        severity: severityFromAlertLevel(alert_level),
        area_name: volcanoInfo.name,
        latitude: volcanoInfo.lat,
        longitude: volcanoInfo.lon,
        occurred_at: reported_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            ...unknownFields,
        },
    };
}