import type { Filter } from 'mongodb';
import { getHazards, getSourceStatus } from './mongo.js';
import type { HazardEvent } from '../utils/mapper.js';

const MAX_LIMIT = 200;

export interface HazardFilter {
    hazard_type?: HazardEvent['hazard_type'] | undefined;
    severity?: HazardEvent['severity'] | undefined;
    source?: HazardEvent['source'] | undefined;
    since?: string | undefined;
}

export type SourceStatuses = Record<'BMKG' | 'PVMBG', string | null>;

// Returns true only when a new document was inserted (false = it already existed and was updated).
export async function upsertHazard(h: HazardEvent): Promise<boolean> {
    const hazards = getHazards();
    const { hazard_id, ...rest } = h;
    const result = await hazards.updateOne(
        { source: h.source, source_ref_id: h.source_ref_id },
        { $set: rest, $setOnInsert: { hazard_id } },
        { upsert: true }
    );
    return result.upsertedCount > 0;
}

export async function findHazards(filter: HazardFilter, limit: number): Promise<HazardEvent[]> {
    const query: Filter<HazardEvent> = {};
    if (filter.hazard_type) query.hazard_type = filter.hazard_type;
    if (filter.severity) query.severity = filter.severity;
    if (filter.source) query.source = filter.source;
    if (filter.since) query.occurred_at = { $gte: filter.since };

    const safeLimit = Number.isFinite(limit)
        ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT)
        : MAX_LIMIT;

    const docs = await getHazards()
        .find(query)
        .sort({ occurred_at: -1 })
        .limit(safeLimit)
        .toArray();

    return docs.map(({ _id, ...rest }) => rest);
}

export async function markSourceSuccess(source: 'BMKG' | 'PVMBG'): Promise<void> {
    await getSourceStatus().updateOne(
        { _id: source },
        { $set: { last_success_at: new Date().toISOString() } },
        { upsert: true }
    );
}

export async function getSourceStatuses(): Promise<SourceStatuses> {
    const docs = await getSourceStatus().find().toArray();
    const statuses: SourceStatuses = { BMKG: null, PVMBG: null };
    for (const d of docs) {
        statuses[d._id] = d.last_success_at;
    }
    return statuses;
}
