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
    attributes: Record<string, any>; // Menampung field dinamis seperti confidence_level
}

export function mapSeismicToHazard(raw: any, tsunamiWarning?: any): HazardEvent {
    const attributes: Record<string, any> = {
        magnitude: raw.magnitude,
        depth_km: raw.depth_km,
        potential_tsunami: raw.potential_tsunami
    };

    let severity: HazardEvent['severity'] = 'NORMAL';
    
    if (tsunamiWarning) {
        severity = tsunamiWarning.threat_level.toUpperCase();
        attributes.tsunami_warning = tsunamiWarning;
    } else {
        if (raw.magnitude >= 6.5) severity = 'SIAGA';
        else if (raw.magnitude >= 5.0) severity = 'WASPADA';
    }

    return {
        hazard_id: `HZ-${crypto.randomUUID()}`,
        source: 'BMKG',
        source_ref_id: raw.event_id,
        hazard_type: 'SEISMIC',
        severity,
        area_name: raw.region_name,
        latitude: raw.epicenter_lat,
        longitude: raw.epicenter_lon,
        occurred_at: raw.occurred_at,
        ingested_at: new Date().toISOString(),
        attributes
    };
}

export function mapVolcanicToHazard(raw: any): HazardEvent {
    const volcanoDict: Record<string, { name: string, lat: number, lon: number }> = {
        'VOLC-01': { name: 'Gunung Prikitiw', lat: -7.5, lon: 110.4 },
        'VOLC-02': { name: 'Gunung Skypiea', lat: -8.1, lon: 112.3 },
        // (tambahkan mock data lainnya)
    };
    
    const volcanoInfo = volcanoDict[raw.volcano_id] || { name: raw.volcano_id, lat: 0, lon: 0 };

    const { 
        report_id, volcano_id, alert_level, reported_at, 
        ...unknownFields
    } = raw;

    return {
        hazard_id: `HZ-${crypto.randomUUID()}`,
        source: 'PVMBG',
        source_ref_id: report_id,
        hazard_type: 'VOLCANIC',
        severity: alert_level.toUpperCase() as HazardEvent['severity'],
        area_name: volcanoInfo.name,
        latitude: volcanoInfo.lat,
        longitude: volcanoInfo.lon,
        occurred_at: reported_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            ...unknownFields
        }
    };
}