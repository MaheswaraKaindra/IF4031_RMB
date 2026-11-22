import type { Collection, Db } from 'mongodb';
import { bookkeepingOptions } from '../../storage/health.js';

export interface FeedLogEntry {
    offset: number;
    kind: string;
    raw: string; // the SSE data field exactly as received
    received_at: string;
}

/** Append-only record of the feed keyed by source offset. Its tail is the durable "received" position. */
export interface IFeedLog {
    append(entries: FeedLogEntry[]): Promise<void>;
    read(fromOffset: number, limit: number): Promise<FeedLogEntry[]>;
    // Highest stored offset, or -1 when empty. The client guarantees contiguity, so this is also the resume point minus one.
    tail(): Promise<number>;
}

export class InMemoryFeedLog implements IFeedLog {
    private readonly entries = new Map<number, FeedLogEntry>();

    async append(entries: FeedLogEntry[]): Promise<void> {
        for (const e of entries) if (!this.entries.has(e.offset)) this.entries.set(e.offset, e);
    }

    async read(fromOffset: number, limit: number): Promise<FeedLogEntry[]> {
        const out: FeedLogEntry[] = [];
        for (let o = fromOffset; out.length < limit; o++) {
            const e = this.entries.get(o);
            if (!e) break;
            out.push(e);
        }
        return out;
    }

    async tail(): Promise<number> {
        let max = -1;
        for (const o of this.entries.keys()) if (o > max) max = o;
        return max;
    }
}

interface FeedLogDoc extends FeedLogEntry {
    _id: number;
}

export class MongoFeedLog implements IFeedLog {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'satellite_feed_log') {}

    private coll(): Collection<FeedLogDoc> {
        return this.getDb().collection<FeedLogDoc>(this.collectionName, bookkeepingOptions());
    }

    async append(entries: FeedLogEntry[]): Promise<void> {
        // Ordered: a failure stops the batch at the first bad entry, so the stored offsets always form a prefix and the log tail
        // never jumps over a hole. An entry that already exists (a replayed frame) is skipped and the rest is written.
        let rest = entries;
        while (rest.length > 0) {
            try {
                await this.coll().insertMany(rest.map((e) => ({ _id: e.offset, ...e })), { ordered: true });
                return;
            } catch (err) {
                const index = duplicateKeyIndex(err);
                if (index === undefined) throw err;
                rest = rest.slice(index + 1);
            }
        }
    }

    async read(fromOffset: number, limit: number): Promise<FeedLogEntry[]> {
        const docs = await this.coll().find({ _id: { $gte: fromOffset } }).sort({ _id: 1 }).limit(limit).toArray();
        const out: FeedLogEntry[] = [];
        let expected = fromOffset;
        for (const d of docs) {
            if (d._id !== expected) break;
            out.push({ offset: d._id, kind: d.kind, raw: d.raw, received_at: d.received_at });
            expected++;
        }
        return out;
    }

    async tail(): Promise<number> {
        const doc = await this.coll().find().sort({ _id: -1 }).limit(1).next();
        return doc ? doc._id : -1;
    }
}

/** Index of the failing entry when an ordered insert stopped on a duplicate key, otherwise undefined (a real error). */
function duplicateKeyIndex(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const e = err as { code?: unknown; writeErrors?: Array<{ code?: unknown; index?: unknown }>; result?: { result?: { writeErrors?: Array<{ code?: unknown; index?: unknown }> } } };
    const errs = Array.isArray(e.writeErrors) ? e.writeErrors : e.result?.result?.writeErrors;
    if (Array.isArray(errs) && errs.length > 0) {
        const first = errs[0]!;
        return first.code === 11000 && typeof first.index === 'number' && errs.every((w) => w.code === 11000) ? first.index : undefined;
    }
    return e.code === 11000 ? 0 : undefined;
}
