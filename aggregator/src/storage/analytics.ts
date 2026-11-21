import type { AnalyticsQuery, AnalyticsResult, Bucket, HazardRecord } from './types.js';

export function bucketStart(iso: string, bucket: Bucket): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'invalid';
    if (bucket === 'hour') d.setUTCMinutes(0, 0, 0);
    else {
        d.setUTCHours(0, 0, 0, 0);
        if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
    }
    return d.toISOString();
}

export function hasTsunamiFlag(r: Pick<HazardRecord, 'hazard_type' | 'attributes'>): boolean {
    if (r.hazard_type !== 'SEISMIC') return false;
    return r.attributes?.['potential_tsunami'] === true || r.attributes?.['tsunami_warning'] != null;
}

// Counts LOGICAL records: callers feed each record exactly once (never once per replica).
export class AnalyticsAccumulator {
    private total = 0;
    private tsunami = 0;
    private readonly series: Record<string, Record<string, number>> = {};
    private readonly byType: Record<string, number> = {};
    private readonly bySeverity: Record<string, number> = {};
    private readonly byArea: Record<string, number> = {};

    constructor(private readonly q: AnalyticsQuery) {}

    add(r: Pick<HazardRecord, 'hazard_type' | 'severity' | 'area_name' | 'occurred_at' | 'attributes'>): void {
        if (this.q.from && r.occurred_at < this.q.from) return;
        if (this.q.to && r.occurred_at > this.q.to) return;
        this.total++;
        const b = bucketStart(r.occurred_at, this.q.bucket);
        const perType = (this.series[r.hazard_type] ??= {});
        perType[b] = (perType[b] ?? 0) + 1;
        this.byType[r.hazard_type] = (this.byType[r.hazard_type] ?? 0) + 1;
        this.bySeverity[r.severity] = (this.bySeverity[r.severity] ?? 0) + 1;
        this.byArea[r.area_name] = (this.byArea[r.area_name] ?? 0) + 1;
        if (hasTsunamiFlag(r)) {
            // Derived category "tsunami": a SEISMIC record that carries a tsunami potential/warning. It is ALSO counted under SEISMIC,
            // so it is reported separately (series + tsunami_flagged) and never added into `total`.
            this.tsunami++;
            const perTsunami = (this.series['TSUNAMI'] ??= {});
            perTsunami[b] = (perTsunami[b] ?? 0) + 1;
        }
    }

    result(partial: boolean, unavailable: string[]): AnalyticsResult {
        return {
            total: this.total,
            series: this.series,
            by_hazard_type: this.byType,
            by_severity: this.bySeverity,
            by_area: this.byArea,
            tsunami_flagged: this.tsunami,
            as_of: new Date().toISOString(),
            partial,
            unavailable_units: unavailable,
        };
    }
}
