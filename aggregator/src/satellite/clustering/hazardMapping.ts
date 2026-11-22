import { hazardIdFor } from '../../storage/identity.js';
import type { HazardRecord } from '../../storage/types.js';
import type { Fire } from './fire.js';
import { nearestProvince } from './provinces.js';

export function fireToHazard(fire: Fire, ingestedAt: string): HazardRecord {
    return {
        hazard_id: hazardIdFor('SATELIT', fire.fire_id),
        source: 'SATELIT',
        source_ref_id: fire.fire_id,
        hazard_type: 'WILDFIRE',
        severity: fire.severity,
        area_name: nearestProvince(fire.latitude, fire.longitude),
        latitude: fire.latitude,
        longitude: fire.longitude,
        occurred_at: new Date(fire.occurred_ms).toISOString(),
        ingested_at: ingestedAt,
        attributes: {
            detection_count: fire.detection_count,
            satellites: fire.satellites,
            max_confidence: fire.max_confidence,
            total_frp_mw: fire.total_frp_mw,
            detection_keys: fire.detection_keys,
        },
    };
}

export function fireHazardId(fireId: string): string {
    return hazardIdFor('SATELIT', fireId);
}
