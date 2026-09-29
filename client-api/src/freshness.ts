import { config } from './config.js';
import type { SourceFreshness, SourceName, SourceStatuses } from './types.js';

function describeSource(lastSuccessAt: string | null, now: number): SourceFreshness {
    const stale = lastSuccessAt === null || now - Date.parse(lastSuccessAt) > config.staleAfterMs;
    return {
        last_success_at: lastSuccessAt,
        stale,
        stale_since: stale ? lastSuccessAt : null,
    };
}

export function buildSources(statuses: SourceStatuses, now: number = Date.now()): Record<SourceName, SourceFreshness> {
    return {
        BMKG: describeSource(statuses.BMKG, now),
        PVMBG: describeSource(statuses.PVMBG, now),
    };
}
