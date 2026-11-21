// Storage contract shared by Owners A/B/C. Everything above the database goes through ICanonicalRepository.
// Nothing here knows whether the backing store is MongoDB, a fake, or something else.

export type Source = 'BMKG' | 'PVMBG' | 'SATELIT' | 'SENSOR_PANTAI';
export type HazardType = 'SEISMIC' | 'VOLCANIC' | 'WILDFIRE' | 'COASTAL';
export type Severity = 'NORMAL' | 'WASPADA' | 'SIAGA' | 'AWAS';

export const SOURCES: readonly Source[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'];
export const HAZARD_TYPES: readonly HazardType[] = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL'];

export interface HazardRecord {
    hazard_id: string;
    source: Source;
    source_ref_id: string;
    hazard_type: HazardType;
    severity: Severity;
    area_name: string;
    latitude: number;
    longitude: number;
    occurred_at: string; // ISO 8601 UTC
    ingested_at: string; // ISO 8601 UTC, set once when BNPB first stored the record
    attributes: Record<string, unknown>;
}

// Outcome of one write. `unavailable` means the outcome is UNKNOWN (timeout / lost quorum): the
// caller must retry with the same identity (idempotent) or read back, never assume it failed.
export type IngestOutcome = 'applied' | 'duplicate' | 'stale_version' | 'stale_epoch' | 'unavailable';

export interface IngestInput {
    event: HazardRecord;
    // Monotonic per-record version from the source (retract/update ordering). Omit for M1 pollers.
    eventVersion?: number | undefined;
    // Leader epoch of the writer. A record already written under a higher epoch rejects the write.
    // Fence and write are ONE atomic operation per record; there is no check-then-write window.
    epoch?: number | undefined;
}

export interface IngestResult {
    outcome: IngestOutcome;
    hazard_id: string;
    created?: boolean | undefined; // true when this call inserted a new record (M1 publishes only on insert)
    // Write-concern timeout: the record IS stored (primary) but the second data member has not confirmed yet.
    degraded?: boolean | undefined;
    detail?: string | undefined;
}

export type SortOrder = 'occurred_desc' | 'ingested_asc';

export interface RecordFilter {
    source?: Source | undefined;
    hazard_type?: HazardType | undefined;
    severity?: Severity | undefined;
    since?: string | undefined; // occurred_desc: occurred_at >= since; ingested_asc: ingested_at >= since
}

export interface GlobalQuery {
    sort: SortOrder;
    filter?: RecordFilter | undefined;
    limit: number;
    cursor?: string | undefined; // opaque, from a previous page
}

export interface Page<T> {
    items: T[];
    next_cursor: string | null;
    partial: boolean;
    unavailable_units: string[];
}

export type Bucket = 'hour' | 'day' | 'week';

export interface AnalyticsQuery {
    from?: string | undefined;
    to?: string | undefined;
    bucket: Bucket;
}

export interface AnalyticsResult {
    total: number;
    // hazard_type -> bucket start (ISO) -> count
    series: Record<string, Record<string, number>>;
    by_hazard_type: Record<string, number>;
    by_severity: Record<string, number>;
    by_area: Record<string, number>;
    tsunami_flagged: number; // SEISMIC records carrying a tsunami potential/warning
    as_of: string;
    partial: boolean;
    unavailable_units: string[];
}

export interface ChecksumResult {
    source: Source | 'ALL';
    count: number;
    checksum: string;
    algorithm: 'sha256';
    as_of: string;
    partial: boolean;
    unavailable_units: string[];
}

export interface Location {
    node: string;
    unit: string;
    role: 'primary' | 'replica';
}

export interface LocateResult {
    hazard_id: string;
    locations: Location[];
    partial: boolean;
}

export interface UnitStatus {
    unit: string;
    available: boolean;
    detail?: string | undefined;
}

export interface ICanonicalRepository {
    ingest(input: IngestInput): Promise<IngestResult>;
    getById(hazardId: string): Promise<HazardRecord | null>;
    remove(hazardId: string, epoch?: number): Promise<IngestResult>;
    queryGlobal(q: GlobalQuery): Promise<Page<HazardRecord>>;
    aggregate(q: AnalyticsQuery): Promise<AnalyticsResult>;
    checksum(source?: Source): Promise<ChecksumResult>;
    locate(hazardId: string): Promise<LocateResult | null>;
    unitStatus(): Promise<UnitStatus[]>;
}

export class InvalidCursorError extends Error {
    constructor() {
        super('invalid cursor');
    }
}
