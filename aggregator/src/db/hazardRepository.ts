import type { Filter } from 'mongodb';
import { getHazards, getSourceStatus, isSharded } from './mongo.js';
import { getRepository } from '../storage/runtime.js';
import { hazardIdFor } from '../storage/identity.js';
import { logger } from '../logger.js';
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
    if (isSharded()) {
        const r = await getRepository().ingest({ event: h });
        if (r.outcome === 'unavailable') throw new Error(`store unavailable: ${r.detail ?? 'unknown outcome'}`);
        if (r.degraded) logger.warn({ hazard_id: r.hazard_id, detail: r.detail }, 'degraded write: stored on one copy until the shard member re-syncs');
        return r.created === true;
    }
    const hazards = getHazards();
    const { hazard_id, ingested_at, ...rest } = h;
    const result = await hazards.updateOne(
        { source: h.source, source_ref_id: h.source_ref_id },
        { $set: rest, $setOnInsert: { hazard_id, ingested_at } },
        { upsert: true }
    );
    return result.upsertedCount > 0;
}

export interface HazardsPage {
    events: HazardEvent[];
    partial: boolean;
    unavailable_units: string[];
}

// Sharded layout: answers even when a storage unit is unreachable, flagging the result as partial.
export async function findHazardsPaged(filter: HazardFilter, limit: number): Promise<HazardsPage> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT) : MAX_LIMIT;
    const page = await getRepository().queryGlobal({ sort: 'occurred_desc', limit: safeLimit, filter });
    return { events: page.items as HazardEvent[], partial: page.partial, unavailable_units: page.unavailable_units };
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
    const doc = await getHazards().findOne(isSharded() ? { _id: hazardIdFor(source, sourceRefId) as never } : { source, source_ref_id: sourceRefId });
    if (!doc) return null;
    const { _id, ...rest } = doc as any;
    return rest as HazardEvent;
}

// Applies a tsunami warning that arrived after its event was stored.
// ingested_at is left alone: it is when BNPB first received the event.
export async function attachTsunamiWarning(
    hazardId: string,
    newSeverity: HazardEvent['severity'],
    tsunamiWarning: unknown,
    epoch?: number | undefined
): Promise<boolean> {
    const base: Record<string, unknown> = isSharded() ? { _id: hazardId as never } : { hazard_id: hazardId };
    const filter =
        epoch === undefined
            ? base
            : { ...base, $or: [{ fence_epoch: { $exists: false } }, { fence_epoch: { $lte: epoch } }] };
    const update: Record<string, unknown> = {
        $set: { severity: newSeverity, 'attributes.tsunami_warning': tsunamiWarning },
        ...(epoch === undefined ? {} : { $max: { fence_epoch: epoch } }),
    };
    const result = await getHazards().updateOne(filter, update);
    return result.modifiedCount > 0;
}
