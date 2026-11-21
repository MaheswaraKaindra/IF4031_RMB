import type { Db } from 'mongodb';
import { bookkeepingOptions } from '../../storage/health.js';
import type { ProcessorSnapshot } from './processor.js';

/**
 * Periodic snapshot of the processor state, so a new leader does not have to replay the whole feed log (1.17 million frames took 195 s
 * on the real feed, and the time grows with the log). A snapshot is the state after applying frames 0..offset and is only written after the
 * checkpoint for that offset is committed, so offset <= committed always. It is a pure function of the log prefix, so any instance may
 * write it and an older one never replaces a newer one. Anything wrong with it makes the runner fall back to the full replay.
 */
export interface StoredSnapshot {
    offset: number;
    state: ProcessorSnapshot;
}

export interface ISnapshotStore {
    get(): Promise<StoredSnapshot | null>;
    put(snapshot: StoredSnapshot): Promise<void>;
}

export class InMemorySnapshotStore implements ISnapshotStore {
    snapshot: StoredSnapshot | null = null;
    puts = 0;
    async get(): Promise<StoredSnapshot | null> {
        return this.snapshot ? JSON.parse(JSON.stringify(this.snapshot)) : null;
    }
    async put(snapshot: StoredSnapshot): Promise<void> {
        this.puts += 1;
        if (!this.snapshot || this.snapshot.offset < snapshot.offset) this.snapshot = JSON.parse(JSON.stringify(snapshot));
    }
}

interface SnapshotDoc {
    _id: string;
    offset: number;
    state_json: string; // one string: the state has nested maps, and a string cannot trip BSON key rules (keys contain dots and pipes)
    bytes: number;
    updated_at: string;
}

export class MongoSnapshotStore implements ISnapshotStore {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'satellite_snapshots', private readonly id = 'processor') {}

    private coll() {
        return this.getDb().collection<SnapshotDoc>(this.collectionName, bookkeepingOptions());
    }

    async get(): Promise<StoredSnapshot | null> {
        const doc = await this.coll().findOne({ _id: this.id });
        if (!doc) return null;
        return { offset: doc.offset, state: JSON.parse(doc.state_json) as ProcessorSnapshot };
    }

    async put(snapshot: StoredSnapshot): Promise<void> {
        const state_json = JSON.stringify(snapshot.state);
        if (state_json.length > 12_000_000) throw new Error(`snapshot too large (${state_json.length} bytes)`);
        const doc = { offset: snapshot.offset, state_json, bytes: state_json.length, updated_at: new Date().toISOString() };
        // Only move forward: when two instances write at the same time the newer snapshot wins.
        const res = await this.coll().updateOne({ _id: this.id, offset: { $lt: snapshot.offset } }, { $set: doc });
        if (res.matchedCount > 0) return;
        try {
            await this.coll().insertOne({ _id: this.id, ...doc });
        } catch (err) {
            if ((err as { code?: number }).code !== 11000) throw err; // already there with an equal or newer offset
        }
    }
}
