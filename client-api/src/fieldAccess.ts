import type { HazardEvent, Scope } from './types.js';

export type HazardField = keyof HazardEvent;

export const SUMMARY_FIELDS: readonly HazardField[] = [
    'hazard_id',
    'source',
    'hazard_type',
    'severity',
    'area_name',
    'occurred_at',
    'ingested_at',
];

export const RAW_FIELDS: readonly HazardField[] = ['source_ref_id', 'latitude', 'longitude', 'attributes'];

export const ALL_FIELDS: readonly HazardField[] = [...SUMMARY_FIELDS, ...RAW_FIELDS];

export function defaultFields(scope: Scope): readonly HazardField[] {
    return scope === 'events:read:raw' ? ALL_FIELDS : SUMMARY_FIELDS;
}

export function forbiddenFields(scope: Scope, requested: readonly HazardField[]): HazardField[] {
    if (scope === 'events:read:raw') return [];
    return requested.filter((field) => RAW_FIELDS.includes(field));
}

export function project(event: HazardEvent, fields: readonly HazardField[]): Partial<HazardEvent> {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        if (field in event) result[field] = event[field];
    }
    return result as Partial<HazardEvent>;
}
