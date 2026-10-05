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
    attributes: Record<string, any>; // Holds dynamic fields such as confidence_level
}

// Map threat_level string (e.g. from a tsunami warning) to canonical severity.
// Exported so aggregator can recompute severity when a late warning arrives.
export function recomputeSeverityFromWarning(tsunamiWarning: any): HazardEvent['severity'] {
    const upper = (tsunamiWarning?.threat_level ?? '').toUpperCase() as HazardEvent['severity'];
    const valid: ReadonlyArray<HazardEvent['severity']> = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    return valid.includes(upper) ? upper : 'WASPADA'; // conservative default
}

export function mapSeismicToHazard(raw: any, tsunamiWarning?: any): HazardEvent {
    // Destructure canonical fields; collect everything else into unknownFields.
    // This mirrors the volcanic mapper so the declared P1 "unknown fields → attributes"
    // policy is enforced uniformly for both BMKG and PVMBG sources.
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
            magnitude,
            depth_km,
            potential_tsunami,
            ...(tsunamiWarning ? { tsunami_warning: tsunamiWarning } : {}),
            // Spec: every field without a canonical equivalent goes to attributes
            ...unknownFields,
        },
    };
}

export function mapVolcanicToHazard(raw: any): HazardEvent {
    // Complete volcano reference table (VOLC-01 … VOLC-05).
    // Without this, VOLC-03/04/05 would fall back to coordinates 0,0 — a spec violation.
    const volcanoDict: Record<string, { name: string; lat: number; lon: number }> = {
        'VOLC-01': { name: 'Mount Prikitiw', lat: -7.542, lon: 110.446 },
        'VOLC-02': { name: 'Mount Skypiea',  lat: -8.108, lon: 112.308 },
        'VOLC-03': { name: 'Mount Merapi',   lat: -7.541, lon: 110.446 },
        'VOLC-04': { name: 'Mount Semeru',   lat: -8.108, lon: 112.922 },
        'VOLC-05': { name: 'Mount Kelud',    lat: -7.930, lon: 112.308 },
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
        // toUpperCase() can throw if alert_level is null/undefined; let it propagate so
        // the per-record try/catch in the aggregator can skip and log the bad record.
        severity: (alert_level as string).toUpperCase() as HazardEvent['severity'],
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