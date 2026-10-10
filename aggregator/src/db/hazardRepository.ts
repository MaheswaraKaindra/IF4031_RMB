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

export interface SourceStatus {
    last_success_at: string | null;
    last_failure_at: string | null; // set while the latest poll failed, null when the source is healthy
}

export type SourceStatuses = Record<'BMKG' | 'PVMBG', SourceStatus>;

// true only when a new document was inserted (false = it already existed and was only updated).
// hazard_id and ingested_at are set on insert only: they keep the first value when the same record is fetched again.
export async function upsertHazard(h: HazardEvent): Promise<boolean> {
    const hazards = getHazards();
    const { hazard_id, ingested_at, ...rest } = h;
    const result = await hazards.updateOne(
        { source: h.source, source_ref_id: h.source_ref_id },
        { $set: rest, $setOnInsert: { hazard_id, ingested_at } },
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
        { $set: { last_success_at: new Date().toISOString() }, $unset: { last_failure_at: '' } },
        { upsert: true }
    );
}

export async function markSourceFailure(source: 'BMKG' | 'PVMBG'): Promise<void> {
    await getSourceStatus().updateOne(
        { _id: source },
        { $set: { last_failure_at: new Date().toISOString() } },
        { upsert: true }
    );
}

export async function getSourceStatuses(): Promise<SourceStatuses> {
    const docs = await getSourceStatus().find().toArray();
    const statuses: SourceStatuses = {
        BMKG: { last_success_at: null, last_failure_at: null },
        PVMBG: { last_success_at: null, last_failure_at: null },
    };
    for (const d of docs) {
        statuses[d._id] = { last_success_at: d.last_success_at ?? null, last_failure_at: d.last_failure_at ?? null };
    }
    return statuses;
}

export async function findHazardBySourceRef(
    source: HazardEvent['source'],
    sourceRefId: string
): Promise<HazardEvent | null> {
    const doc = await getHazards().findOne({ source, source_ref_id: sourceRefId });
    if (!doc) return null;
    const { _id, ...rest } = doc as any;
    return rest as HazardEvent;
}

// Applies a tsunami warning that arrived after its event was stored.
// ingested_at is left alone: it is when BNPB first received the event.
export async function attachTsunamiWarning(
    hazardId: string,
    newSeverity: HazardEvent['severity'],
    tsunamiWarning: unknown
): Promise<boolean> {
    const result = await getHazards().updateOne(
        { hazard_id: hazardId },
        { $set: { severity: newSeverity, 'attributes.tsunami_warning': tsunamiWarning } }
    );
    return result.modifiedCount > 0;
}
