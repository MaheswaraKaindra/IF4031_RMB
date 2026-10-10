import { config } from './config.js';
import type { SourceFreshness, SourceName, SourceStatus, SourceStatuses } from './types.js';

function describeSource(status: SourceStatus, now: number): SourceFreshness {
    const { last_success_at, last_failure_at } = status;
    const stale =
        last_success_at === null || last_failure_at !== null || now - Date.parse(last_success_at) > config.staleAfterMs;
    return {
        last_success_at,
        stale,
        stale_since: stale ? last_success_at : null,
    };
}

export function buildSources(statuses: SourceStatuses, now: number = Date.now()): Record<SourceName, SourceFreshness> {
    return {
        BMKG: describeSource(statuses.BMKG, now),
        PVMBG: describeSource(statuses.PVMBG, now),
    };
}
