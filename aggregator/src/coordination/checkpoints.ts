import type { Collection, Db } from 'mongodb';
import type { Checkpoint, ICheckpoint } from '../storage/contracts.js';

interface CheckpointDoc extends Checkpoint {
    _id: string;
    updated_at: string;
}

export class MongoCheckpointStore implements ICheckpoint {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'source_checkpoints') {}

    private coll(): Collection<CheckpointDoc> {
        return this.getDb().collection<CheckpointDoc>(this.collectionName);
    }

    async get(source: string, partition: string): Promise<Checkpoint | null> {
        const doc = await this.coll().findOne({ _id: `${source}:${partition}` });
        if (!doc) return null;
        return {
            source: doc.source,
            partition: doc.partition,
            received_offset: doc.received_offset,
            committed_offset: doc.committed_offset,
            state_version: doc.state_version,
            owner_epoch: doc.owner_epoch,
        };
    }

    async commit(
        next: Checkpoint,
        expectedStateVersion: number
    ): Promise<'applied' | 'stale_epoch' | 'conflict' | 'unavailable'> {
        const id = `${next.source}:${next.partition}`;
        const now = new Date().toISOString();
        try {
            const doc = await this.coll().findOneAndUpdate(
                {
                    _id: id,
                    state_version: expectedStateVersion,
                    owner_epoch: { $lte: next.owner_epoch },
                },
                {
                    $set: {
                        source: next.source,
                        partition: next.partition,
                        received_offset: next.received_offset,
                        committed_offset: next.committed_offset,
                        state_version: next.state_version,
                        owner_epoch: next.owner_epoch,
                        updated_at: now,
                    },
                },
                { upsert: expectedStateVersion === 0, returnDocument: 'after' }
            );
            if (doc) return 'applied';
        } catch (err) {
            if (!isDupKey(err)) return 'unavailable';
        }

        try {
            const cur = await this.coll().findOne({ _id: id });
            if (cur && cur.owner_epoch > next.owner_epoch) return 'stale_epoch';
            return 'conflict';
        } catch {
            return 'unavailable';
        }
    }
}

export class InMemoryCheckpointStore implements ICheckpoint {
    private readonly store = new Map<string, Checkpoint>();

    async get(source: string, partition: string): Promise<Checkpoint | null> {
        const cur = this.store.get(`${source}:${partition}`);
        return cur ? { ...cur } : null;
    }

    async commit(
        next: Checkpoint,
        expectedStateVersion: number
    ): Promise<'applied' | 'stale_epoch' | 'conflict' | 'unavailable'> {
        const key = `${next.source}:${next.partition}`;
        const cur = this.store.get(key);
        if (!cur) {
            if (expectedStateVersion !== 0) return 'conflict';
            this.store.set(key, { ...next });
            return 'applied';
        }
        if (cur.owner_epoch > next.owner_epoch) return 'stale_epoch';
        if (cur.state_version !== expectedStateVersion) return 'conflict';
        this.store.set(key, { ...next });
        return 'applied';
    }
}

function isDupKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}
