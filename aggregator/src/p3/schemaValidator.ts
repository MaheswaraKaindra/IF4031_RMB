import { hazardIdFor } from '../storage/identity.js';
import type { HazardType, Severity } from '../storage/types.js';
import { mapSeismicToHazard, mapVolcanicToHazard, type HazardEvent } from '../utils/mapper.js';

export interface SchemaRulesConfig {
    /**
     * Declared schema policy:
     * - additive fields are accepted automatically and preserved in HazardEvent.attributes
     * - incompatible changes (rename, type change, missing required field, unknown enum) are parked
     *   until Ops enables compatible v2 adapter rules or deploys updated decoder code.
     */
    enablePvmbgV2Compat: boolean;
    fieldAliases: Record<string, string>; // e.g. { mountain_code: 'volcano_id', status_level: 'alert_level' }
    coerceNumericStrings: boolean;
    defaults: Record<string, unknown>; // optional fallback values for newly optional/missing fields after schema migration
}

export const defaultSchemaRules = (): SchemaRulesConfig => ({
    enablePvmbgV2Compat: process.env.PVMBG_SCHEMA_V2 === '1',
    fieldAliases: process.env.PVMBG_SCHEMA_V2 === '1'
        ? { mountain_code: 'volcano_id', status_level: 'alert_level' }
        : {},
    coerceNumericStrings: process.env.PVMBG_SCHEMA_V2 === '1',
    defaults: {},
});

const WORD_NUMBERS: Record<string, number> = {
    zero: 0, nol: 0, one: 1, satu: 1, two: 2, dua: 2, three: 3, tiga: 3,
    four: 4, empat: 4, five: 5, lima: 5,
};

function parseFiniteNumber(val: unknown, coerceStrings: boolean): number | null {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (coerceStrings && typeof val === 'string') {
        const trimmed = val.trim().toLowerCase();
        if (trimmed in WORD_NUMBERS) return WORD_NUMBERS[trimmed]!;
        if (trimmed !== '') {
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

export type ValidationResult<T> =
    | { ok: true; value: T; schemaVersion: string }
    | { ok: false; reason: string; sourceRefId?: string | undefined };

const VALID_ALERT_LEVELS = new Set(['NORMAL', 'WASPADA', 'SIAGA', 'AWAS']);

export function validateAndMapPvmbgRecord(
    rawInput: unknown,
    rules: SchemaRulesConfig
): ValidationResult<HazardEvent> {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
        return { ok: false, reason: 'schema_incompatible: volcanic report must be a JSON object' };
    }

    const record: Record<string, unknown> = { ...(rawInput as Record<string, unknown>) };
    const sourceRefId = typeof record['report_id'] === 'string' && record['report_id'].length > 0
        ? record['report_id']
        : undefined;

    // Apply Ops-configured schema adapter aliases/defaults when v2 compatibility is enabled
    for (const [alias, canonicalKey] of Object.entries(rules.fieldAliases)) {
        if (record[canonicalKey] === undefined && record[alias] !== undefined) {
            record[canonicalKey] = record[alias];
            delete record[alias];
        }
    }
    for (const [key, fallback] of Object.entries(rules.defaults)) {
        if (record[key] === undefined) {
            record[key] = fallback;
        }
    }

    if (typeof record['report_id'] !== 'string' || record['report_id'].trim() === '') {
        return { ok: false, reason: "schema_incompatible: missing or invalid required field 'report_id'", sourceRefId };
    }
    if (typeof record['volcano_id'] !== 'string' || record['volcano_id'].trim() === '') {
        return { ok: false, reason: "schema_incompatible: missing or renamed required field 'volcano_id'", sourceRefId };
    }
    if (typeof record['alert_level'] !== 'string' || !VALID_ALERT_LEVELS.has(record['alert_level'].toUpperCase())) {
        return {
            ok: false,
            reason: `schema_incompatible: field 'alert_level' missing or invalid (${typeof record['alert_level']}: ${String(record['alert_level'])})`,
            sourceRefId,
        };
    }
    if (typeof record['reported_at'] !== 'string' || Number.isNaN(Date.parse(record['reported_at']))) {
        return { ok: false, reason: "schema_incompatible: missing or invalid ISO date 'reported_at'", sourceRefId };
    }

    const eruptions = parseFiniteNumber(record['eruption_count_24h'], rules.coerceNumericStrings);
    if (eruptions === null) {
        return {
            ok: false,
            reason: `schema_incompatible: field 'eruption_count_24h' must be number, got ${typeof record['eruption_count_24h']}`,
            sourceRefId,
        };
    }
    record['eruption_count_24h'] = eruptions;

    const ashHeight = parseFiniteNumber(record['ash_column_height_m'], rules.coerceNumericStrings);
    if (ashHeight === null) {
        return {
            ok: false,
            reason: `schema_incompatible: field 'ash_column_height_m' must be number, got ${typeof record['ash_column_height_m']}`,
            sourceRefId,
        };
    }
    record['ash_column_height_m'] = ashHeight;

    const mapped = mapVolcanicToHazard(record);
    const schemaVersion = record['confidence_level'] !== undefined ? 'pvmbg.v1+additive' : 'pvmbg.v1';
    return { ok: true, value: mapped, schemaVersion };
}

export function validateAndMapBmkgRecord(
    rawInput: unknown,
    strongestWarning?: unknown
): ValidationResult<HazardEvent> {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
        return { ok: false, reason: 'schema_incompatible: seismic event must be a JSON object' };
    }
    const r = rawInput as Record<string, unknown>;
    const sourceRefId = typeof r['event_id'] === 'string' && r['event_id'].length > 0 ? r['event_id'] : undefined;

    if (
        typeof r['event_id'] !== 'string' ||
        typeof r['magnitude'] !== 'number' ||
        typeof r['depth_km'] !== 'number' ||
        typeof r['epicenter_lat'] !== 'number' ||
        typeof r['epicenter_lon'] !== 'number' ||
        typeof r['region_name'] !== 'string' ||
        typeof r['occurred_at'] !== 'string' ||
        Number.isNaN(Date.parse(r['occurred_at'])) ||
        typeof r['potential_tsunami'] !== 'boolean'
    ) {
        return { ok: false, reason: 'schema_incompatible: invalid or missing required BMKG SeismicEvent fields', sourceRefId };
    }

    return { ok: true, value: mapSeismicToHazard(r, strongestWarning), schemaVersion: 'bmkg.v1' };
}

const VALID_HAZARD_TYPES = new Set<HazardType>(['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL']);
const VALID_SEVERITIES = new Set<Severity>(['NORMAL', 'WASPADA', 'SIAGA', 'AWAS']);

export interface FieldReportPayload {
    report_id: string;
    hazard_type: HazardType;
    severity: Severity;
    area_name: string;
    latitude: number;
    longitude: number;
    occurred_at: string;
    attributes?: Record<string, unknown> | undefined;
}

export function validateFieldReport(rawInput: unknown): ValidationResult<FieldReportPayload> {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
        return { ok: false, reason: 'validation: body must be a JSON object' };
    }
    const r = rawInput as Record<string, unknown>;
    const reportId = typeof r['report_id'] === 'string' ? r['report_id'].trim() : '';
    if (!reportId) return { ok: false, reason: "validation: 'report_id' is required" };

    const hazardType = typeof r['hazard_type'] === 'string' ? (r['hazard_type'].toUpperCase() as HazardType) : undefined;
    if (!hazardType || !VALID_HAZARD_TYPES.has(hazardType)) {
        return { ok: false, reason: "validation: 'hazard_type' must be SEISMIC|VOLCANIC|WILDFIRE|COASTAL", sourceRefId: reportId };
    }

    const severity = typeof r['severity'] === 'string' ? (r['severity'].toUpperCase() as Severity) : undefined;
    if (!severity || !VALID_SEVERITIES.has(severity)) {
        return { ok: false, reason: "validation: 'severity' must be NORMAL|WASPADA|SIAGA|AWAS", sourceRefId: reportId };
    }

    const areaName = typeof r['area_name'] === 'string' ? r['area_name'].trim() : '';
    if (!areaName) return { ok: false, reason: "validation: 'area_name' is required", sourceRefId: reportId };

    if (typeof r['latitude'] !== 'number' || !Number.isFinite(r['latitude']) || r['latitude'] < -90 || r['latitude'] > 90) {
        return { ok: false, reason: "validation: 'latitude' must be a valid number in [-90, 90]", sourceRefId: reportId };
    }
    if (typeof r['longitude'] !== 'number' || !Number.isFinite(r['longitude']) || r['longitude'] < -180 || r['longitude'] > 180) {
        return { ok: false, reason: "validation: 'longitude' must be a valid number in [-180, 180]", sourceRefId: reportId };
    }
    if (typeof r['occurred_at'] !== 'string' || Number.isNaN(Date.parse(r['occurred_at']))) {
        return { ok: false, reason: "validation: 'occurred_at' must be a valid ISO 8601 datetime", sourceRefId: reportId };
    }

    const attrs =
        r['attributes'] && typeof r['attributes'] === 'object' && !Array.isArray(r['attributes'])
            ? (r['attributes'] as Record<string, unknown>)
            : {};

    return {
        ok: true,
        schemaVersion: 'field-report.v1',
        value: {
            report_id: reportId,
            hazard_type: hazardType,
            severity,
            area_name: areaName,
            latitude: r['latitude'],
            longitude: r['longitude'],
            occurred_at: new Date(r['occurred_at']).toISOString(),
            attributes: attrs,
        },
    };
}

export function mapFieldReportToHazard(report: FieldReportPayload, principal: string): HazardEvent & { source: 'FIELD_REPORT' } {
    return {
        hazard_id: hazardIdFor('FIELD_REPORT', report.report_id),
        source: 'FIELD_REPORT',
        source_ref_id: report.report_id,
        hazard_type: report.hazard_type,
        severity: report.severity,
        area_name: report.area_name,
        latitude: report.latitude,
        longitude: report.longitude,
        occurred_at: report.occurred_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            ...(report.attributes ?? {}),
            reported_by: principal,
        },
    };
}
