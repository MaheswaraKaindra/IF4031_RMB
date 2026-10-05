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
    attributes: Record<string, unknown>;
}

export type SourceName = 'BMKG' | 'PVMBG';

export type Scope = 'events:read:summary' | 'events:read:raw';

export interface SourceStatus {
    last_success_at: string | null;
    last_failure_at: string | null;
}

export type SourceStatuses = Record<SourceName, SourceStatus>;

export interface SourceFreshness {
    last_success_at: string | null;
    stale: boolean;
    stale_since: string | null;
}
