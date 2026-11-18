import type { Collection, Db } from 'mongodb';
import type { ICanonicalRepository, IngestInput, IngestResult } from '../storage/types.js';

export interface FenceState {
    source: string;
    epoch: number;
    holder_id: string;
    updated_at: string;
}

export interface ISourceFenceStore {
    activateEpoch(source: string, holderId: string): Promise<number>;
    getFence(source: string): Promise<FenceState | null>;
    assertEpoch(source: string, epoch: number): Promise<boolean>;
}

interface SourceFenceDoc {
    _id: string;
    epoch: number;
    holder_id: string;
    updated_at: string;
}

export class MongoSourceFenceStore implements ISourceFenceStore {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'source_fences') {}

    private coll(): Collection<SourceFenceDoc> {
        return this.getDb().collection<SourceFenceDoc>(this.collectionName);
    }

    async activateEpoch(source: string, holderId: string): Promise<number> {
        const doc = await this.coll().findOneAndUpdate(
            { _id: source },
            {
                $inc: { epoch: 1 },
                $set: { holder_id: holderId, updated_at: new Date().toISOString() },
            },
            { upsert: true, returnDocument: 'after' }
        );
        if (!doc || typeof doc.epoch !== 'number') {
            throw new Error(`Failed to activate monotonic epoch for ${source}`);
        }
        return doc.epoch;
    }

    async getFence(source: string): Promise<FenceState | null> {
        const doc = await this.coll().findOne({ _id: source });
        if (!doc) return null;
        return { source: doc._id, epoch: doc.epoch, holder_id: doc.holder_id, updated_at: doc.updated_at };
    }

    async assertEpoch(source: string, epoch: number): Promise<boolean> {
        const doc = await this.coll().findOneAndUpdate(
            { _id: source, epoch },
            { $set: { updated_at: new Date().toISOString() } },
            { returnDocument: 'after' }
        );
        return doc !== null;
    }
}

export class InMemorySourceFenceStore implements ISourceFenceStore {
    private readonly state = new Map<string, FenceState>();

    async activateEpoch(source: string, holderId: string): Promise<number> {
        const nextEpoch = (this.state.get(source)?.epoch ?? 0) + 1;
        this.state.set(source, { source, epoch: nextEpoch, holder_id: holderId, updated_at: new Date().toISOString() });
        return nextEpoch;
    }

    async getFence(source: string): Promise<FenceState | null> {
        return this.state.get(source) ?? null;
    }

    async assertEpoch(source: string, epoch: number): Promise<boolean> {
        const cur = this.state.get(source);
        return cur !== undefined && cur.epoch === epoch;
    }
}

/**
 * Wraps repository writes with source-level monotonic epoch fencing plus per-record epoch checking.
 * If a stale writer manages to insert a brand-new document right as leadership changes, post-write
 * verification catches the epoch mismatch and removes the uncommitted orphan before ack/publish.
 */
export async function fencedIngest(
    repo: ICanonicalRepository,
    fenceStore: ISourceFenceStore,
    input: IngestInput & { epoch: number },
    isLocalLeaderStillValid: () => boolean
): Promise<IngestResult> {
    if (!isLocalLeaderStillValid()) {
        return { outcome: 'stale_epoch', hazard_id: input.event.hazard_id, detail: 'local leadership expired' };
    }
    const source = input.event.source;
    const stillValidBefore = await fenceStore.assertEpoch(source, input.epoch);
    if (!stillValidBefore) {
        return { outcome: 'stale_epoch', hazard_id: input.event.hazard_id, detail: 'superseded by newer epoch' };
    }

    const res = await repo.ingest(input);
    if (res.outcome !== 'applied') return res;

    const stillValidAfter = isLocalLeaderStillValid() && (await fenceStore.assertEpoch(source, input.epoch));
    if (!stillValidAfter) {
        if (res.created) {
            await repo.remove(res.hazard_id, input.epoch).catch(() => undefined);
        }
        return { outcome: 'stale_epoch', hazard_id: res.hazard_id, detail: 'epoch changed during write' };
    }
    return res;
}
