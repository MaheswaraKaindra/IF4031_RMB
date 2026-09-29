export const HAZARD_TYPES = ['SEISMIC', 'VOLCANIC'] as const;
export const SEVERITIES = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'] as const;

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    return null;
}

export function parseLimit(value: unknown, fallback: number): number | null {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') return null;

    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? n : null;
}
