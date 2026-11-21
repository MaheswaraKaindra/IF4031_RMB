import type { Collection, Db } from 'mongodb';
import { bookkeepingOptions } from '../../storage/health.js';
import type { LateDetection } from './processor.js';

export interface ILateStore {
    add(records: LateDetection[]): Promise<void>;
    count(): Promise<number>;
}

export class InMemoryLateStore implements ILateStore {
    readonly records = new Map<string, LateDetection>();

    async add(records: LateDetection[]): Promise<void> {
        for (const r of records) if (!this.records.has(r.key)) this.records.set(r.key, r);
    }

    async count(): Promise<number> {
        return this.records.size;
    }
}

interface LateDoc extends LateDetection {
    _id: string;
    recorded_at: string;
}

/** Detections beyond the allowed lateness, kept by detection key so replays do not count them twice. */
export class MongoLateStore implements ILateStore {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'satellite_late_detections') {}

    private coll(): Collection<LateDoc> {
        return this.getDb().collection<LateDoc>(this.collectionName, bookkeepingOptions());
    }

    async add(records: LateDetection[]): Promise<void> {
        if (records.length === 0) return;
        const now = new Date().toISOString();
        try {
            await this.coll().insertMany(
                records.map((r) => ({ _id: r.key, ...r, recorded_at: now })),
                { ordered: false }
            );
        } catch (err) {
            const e = err as { code?: unknown; writeErrors?: Array<{ code?: unknown }> };
            const dupOnly = Array.isArray(e.writeErrors) && e.writeErrors.length > 0 ? e.writeErrors.every((w) => w.code === 11000) : e.code === 11000;
            if (!dupOnly) throw err;
        }
    }

    async count(): Promise<number> {
        return this.coll().countDocuments();
    }
}
