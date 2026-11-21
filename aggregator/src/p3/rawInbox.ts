import { createHash, randomUUID } from 'node:crypto';
import { Binary, type Collection, type Db } from 'mongodb';
import type { InboxStatus } from '../storage/contracts.js';
import { InvalidCursorError } from '../storage/types.js';
import { bookkeepingOptions } from '../storage/health.js';

export interface RawInboxItem {
    message_id: string;
    source: string;
    source_ref_id?: string | undefined;
    event_version?: number | undefined;
    schema_version?: string | undefined;
    received_at: string;
    created_seq: number;
    raw: Buffer;
    raw_sha256: string;
    status: InboxStatus;
    reason?: string | undefined;
    retryable: boolean;
    attempts: number;
    next_attempt_at?: string | undefined;
    claim_token?: string | undefined;
    claim_expires_at?: string | undefined;
}

export interface UnprocessedAuditItem {
    message_id: string;
    source: string;
    received_at: string;
    reason: string;
    retryable: boolean;
    attempts: number;
    status: 'retrying' | 'parked';
}

export interface AppendInboxInput {
    message_id?: string | undefined;
    source: string;
    source_ref_id?: string | undefined;
    event_version?: number | undefined;
    schema_version?: string | undefined;
    received_at?: string | undefined;
    raw: Buffer;
    status: 'retrying' | 'parked';
    reason: string;
    retryable: boolean;
    attempts?: number | undefined;
    next_attempt_at?: string | undefined;
}

export interface ReplayStats {
    scanned: number;
    recovered: number;
    blocked_by_key: number;
    still_failed: number;
}

export interface RawInboxFilter {
    source?: string | undefined;
    reason?: string | undefined;
}

export type ReplayHandler = (record: RawInboxItem) => Promise<{ ok: true } | { ok: false; retryable: boolean; reason: string }>;

export interface RawInboxStore {
    appendFailure(input: AppendInboxInput): Promise<{ message_id: string; duplicate: boolean }>;
    claimRetryable(limit: number, visibilityMs: number): Promise<RawInboxItem[]>;
    markProcessed(messageId: string, claimToken?: string | undefined): Promise<boolean>;
    markFailed(messageId: string, opts: { claimToken?: string | undefined; retryable: boolean; reason: string; maxAttempts: number; backoffMs?: number | undefined }): Promise<void>;
    hasBlockingFailure(source: string, sourceRefId: string, beforeSeq?: number): Promise<boolean>;
    list(q: { source?: string | undefined; limit: number; cursor?: string | undefined }): Promise<{ items: UnprocessedAuditItem[]; next_cursor: string | null }>;
    replay(filter: RawInboxFilter, handler: ReplayHandler, maxPerSecond: number, maxAttempts?: number | undefined): Promise<ReplayStats>;
    countsByStatus(): Promise<Record<InboxStatus, number>>;
}

export function computeBackoffWithJitter(attempts: number, baseMs = 1000, maxMs = 30_000, rand = Math.random()): number {
    const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
    const jitter = 0.75 + rand * 0.5; // +/-25%
    return Math.round(exp * jitter);
}

function sha256Hex(raw: Buffer): string {
    return createHash('sha256').update(raw).digest('hex');
}

function encodeCursor(receivedAt: string, messageId: string): string {
    return Buffer.from(JSON.stringify({ r: receivedAt, m: messageId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { r: string; m: string } {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof parsed['r'] !== 'string' || typeof parsed['m'] !== 'string') throw new Error('bad');
        return { r: parsed['r'], m: parsed['m'] };
    } catch {
        throw new InvalidCursorError();
    }
}

function toAuditItem(rec: RawInboxItem): UnprocessedAuditItem {
    return {
        message_id: rec.message_id,
        source: rec.source,
        received_at: rec.received_at,
        reason: rec.reason ?? 'unknown',
        retryable: rec.retryable,
        attempts: rec.attempts,
        status: rec.status === 'retrying' ? 'retrying' : 'parked',
    };
}

let localSeqCounter = 0;
function nextMonotonicSeq(): number {
    localSeqCounter = (localSeqCounter + 1) % 1000;
    return Date.now() * 1000 + localSeqCounter;
}

interface MongoInboxDoc {
    _id: string;
    message_id: string;
    source: string;
    source_ref_id?: string;
    event_version?: number;
    schema_version?: string;
    received_at: string;
    created_seq: number;
    raw: Binary;
    raw_sha256: string;
    status: InboxStatus;
    reason?: string;
    retryable: boolean;
    attempts: number;
    next_attempt_at?: string;
    claim_token?: string;
    claim_expires_at?: string;
}

function fromMongoDoc(doc: MongoInboxDoc): RawInboxItem {
    const buf = Buffer.isBuffer(doc.raw) ? doc.raw : Buffer.from(doc.raw.buffer);
    return {
        message_id: doc.message_id,
        source: doc.source,
        source_ref_id: doc.source_ref_id,
        event_version: doc.event_version,
        schema_version: doc.schema_version,
        received_at: doc.received_at,
        created_seq: doc.created_seq,
        raw: buf,
        raw_sha256: doc.raw_sha256,
        status: doc.status,
        reason: doc.reason,
        retryable: doc.retryable,
        attempts: doc.attempts,
        next_attempt_at: doc.next_attempt_at,
        claim_token: doc.claim_token,
        claim_expires_at: doc.claim_expires_at,
    };
}

export class MongoRawInbox implements RawInboxStore {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'raw_inbox') {}

    private coll(): Collection<MongoInboxDoc> {
        return this.getDb().collection<MongoInboxDoc>(this.collectionName, bookkeepingOptions());
    }

    async ensureIndexes(): Promise<void> {
        await this.coll().createIndex({ status: 1, next_attempt_at: 1, claim_expires_at: 1 });
        await this.coll().createIndex({ source: 1, source_ref_id: 1, status: 1, created_seq: 1 });
        await this.coll().createIndex({ received_at: 1, message_id: 1 });
    }

    async appendFailure(input: AppendInboxInput): Promise<{ message_id: string; duplicate: boolean }> {
        const rawSha = sha256Hex(input.raw);
        const dedupId =
            input.message_id ??
            `msg-${createHash('sha256').update(`${input.source}\u0000${rawSha}`).digest('hex').slice(0, 12)}`;
        const now = input.received_at ?? new Date().toISOString();

        // Preserve original failure if the identical raw payload is already parked/retrying
        const existing = await this.coll().findOne({
            source: input.source,
            raw_sha256: rawSha,
            status: { $in: ['retrying', 'parked', 'processing'] },
        });
        if (existing) return { message_id: existing.message_id, duplicate: true };

        const doc: MongoInboxDoc = {
            _id: dedupId,
            message_id: dedupId,
            source: input.source,
            ...(input.source_ref_id ? { source_ref_id: input.source_ref_id } : {}),
            ...(input.event_version !== undefined ? { event_version: input.event_version } : {}),
            ...(input.schema_version ? { schema_version: input.schema_version } : {}),
            received_at: now,
            created_seq: nextMonotonicSeq(),
            raw: new Binary(input.raw),
            raw_sha256: rawSha,
            status: input.status,
            reason: input.reason,
            retryable: input.retryable,
            attempts: input.attempts ?? 1,
            ...(input.next_attempt_at ? { next_attempt_at: input.next_attempt_at } : {}),
        };

        try {
            await this.coll().insertOne(doc);
            return { message_id: dedupId, duplicate: false };
        } catch (err) {
            if (isDupKey(err)) return { message_id: dedupId, duplicate: true };
            throw err;
        }
    }

    async claimRetryable(limit: number, visibilityMs: number): Promise<RawInboxItem[]> {
        const claimed: RawInboxItem[] = [];
        const nowIso = new Date().toISOString();
        const expiresIso = new Date(Date.now() + visibilityMs).toISOString();

        for (let i = 0; i < limit; i++) {
            const claimToken = randomUUID();
            const doc = await this.coll().findOneAndUpdate(
                {
                    $or: [
                        { status: 'retrying', next_attempt_at: { $lte: nowIso } },
                        { status: 'retrying', next_attempt_at: { $exists: false } },
                        { status: 'processing', claim_expires_at: { $lte: nowIso } },
                    ],
                },
                {
                    $set: {
                        status: 'processing',
                        claim_token: claimToken,
                        claim_expires_at: expiresIso,
                    },
                },
                { sort: { received_at: 1, created_seq: 1 }, returnDocument: 'after' }
            );
            if (!doc) break;
            claimed.push(fromMongoDoc(doc));
        }
        return claimed;
    }

    async markProcessed(messageId: string, claimToken?: string | undefined): Promise<boolean> {
        const filter = claimToken ? { _id: messageId, claim_token: claimToken } : { _id: messageId };
        const res = await this.coll().updateOne(filter, {
            $set: { status: 'processed', retryable: false, processed_at: new Date().toISOString() },
            $unset: { claim_token: '', claim_expires_at: '', next_attempt_at: '' },
        });
        return res.modifiedCount > 0;
    }

    async markFailed(
        messageId: string,
        opts: { claimToken?: string | undefined; retryable: boolean; reason: string; maxAttempts: number; backoffMs?: number | undefined }
    ): Promise<void> {
        const filter = opts.claimToken ? { _id: messageId, claim_token: opts.claimToken } : { _id: messageId };
        const cur = await this.coll().findOne(filter);
        if (!cur) return;

        const nextAttempts = cur.attempts + 1;
        const canRetry = opts.retryable && nextAttempts < opts.maxAttempts;
        const status: InboxStatus = canRetry ? 'retrying' : 'parked';
        const delayMs = opts.backoffMs ?? computeBackoffWithJitter(nextAttempts);
        const nextAttempt = canRetry ? new Date(Date.now() + delayMs).toISOString() : undefined;

        await this.coll().updateOne(filter, {
            $set: {
                status,
                retryable: canRetry,
                reason: !opts.retryable ? opts.reason : canRetry ? opts.reason : `max_attempts_exceeded: ${opts.reason}`,
                attempts: nextAttempts,
                ...(nextAttempt ? { next_attempt_at: nextAttempt } : {}),
            },
            $unset: {
                claim_token: '',
                claim_expires_at: '',
                ...(nextAttempt ? {} : { next_attempt_at: '' }),
            },
        });
    }

    async hasBlockingFailure(source: string, sourceRefId: string, beforeSeq?: number): Promise<boolean> {
        const q: Record<string, unknown> = {
            source,
            source_ref_id: sourceRefId,
            status: { $in: ['retrying', 'parked', 'processing'] },
        };
        if (beforeSeq !== undefined) q['created_seq'] = { $lt: beforeSeq };
        const found = await this.coll().findOne(q, { projection: { _id: 1 } });
        return found !== null;
    }

    async list(q: {
        source?: string | undefined;
        limit: number;
        cursor?: string | undefined;
    }): Promise<{ items: UnprocessedAuditItem[]; next_cursor: string | null }> {
        const filter: Record<string, unknown> = { status: { $in: ['retrying', 'parked'] } };
        if (q.source) filter['source'] = q.source;

        if (q.cursor) {
            const c = decodeCursor(q.cursor);
            filter['$or'] = [
                { received_at: { $gt: c.r } },
                { received_at: c.r, message_id: { $gt: c.m } },
            ];
        }

        const docs = await this.coll()
            .find(filter)
            .sort({ received_at: 1, message_id: 1 })
            .limit(q.limit + 1)
            .toArray();

        const hasMore = docs.length > q.limit;
        const slice = hasMore ? docs.slice(0, q.limit) : docs;
        const last = slice[slice.length - 1];
        return {
            items: slice.map((d) => toAuditItem(fromMongoDoc(d))),
            next_cursor: hasMore && last ? encodeCursor(last.received_at, last.message_id) : null,
        };
    }

    async replay(filter: RawInboxFilter, handler: ReplayHandler, maxPerSecond: number, maxAttempts = 5): Promise<ReplayStats> {
        const q: Record<string, unknown> = { status: { $in: ['parked', 'retrying'] } };
        if (filter.source) q['source'] = filter.source;
        if (filter.reason) q['reason'] = { $regex: filter.reason };

        const docs = await this.coll().find(q).sort({ received_at: 1, created_seq: 1 }).toArray();
        return executeOrderedReplay(docs.map(fromMongoDoc), this, handler, maxPerSecond, maxAttempts);
    }

    async countsByStatus(): Promise<Record<InboxStatus, number>> {
        const rows = await this.coll().aggregate<{ _id: InboxStatus; c: number }>([
            { $group: { _id: '$status', c: { $sum: 1 } } },
        ]).toArray();
        const counts: Record<InboxStatus, number> = { received: 0, processing: 0, processed: 0, retrying: 0, parked: 0 };
        for (const r of rows) counts[r._id] = r.c;
        return counts;
    }
}

export class InMemoryRawInbox implements RawInboxStore {
    private readonly records = new Map<string, RawInboxItem>();

    async appendFailure(input: AppendInboxInput): Promise<{ message_id: string; duplicate: boolean }> {
        const rawSha = sha256Hex(input.raw);
        for (const existing of this.records.values()) {
            if (
                existing.source === input.source &&
                existing.raw_sha256 === rawSha &&
                (existing.status === 'retrying' || existing.status === 'parked' || existing.status === 'processing')
            ) {
                return { message_id: existing.message_id, duplicate: true };
            }
        }
        const messageId =
            input.message_id ??
            `msg-${createHash('sha256').update(`${input.source}\u0000${rawSha}`).digest('hex').slice(0, 12)}`;
        if (this.records.has(messageId)) return { message_id: messageId, duplicate: true };

        this.records.set(messageId, {
            message_id: messageId,
            source: input.source,
            source_ref_id: input.source_ref_id,
            event_version: input.event_version,
            schema_version: input.schema_version,
            received_at: input.received_at ?? new Date().toISOString(),
            created_seq: nextMonotonicSeq(),
            raw: Buffer.from(input.raw),
            raw_sha256: rawSha,
            status: input.status,
            reason: input.reason,
            retryable: input.retryable,
            attempts: input.attempts ?? 1,
            next_attempt_at: input.next_attempt_at,
        });
        return { message_id: messageId, duplicate: false };
    }

    async claimRetryable(limit: number, visibilityMs: number): Promise<RawInboxItem[]> {
        const nowIso = new Date().toISOString();
        const expiresIso = new Date(Date.now() + visibilityMs).toISOString();
        const sorted = [...this.records.values()].sort(
            (a, b) => a.received_at.localeCompare(b.received_at) || a.created_seq - b.created_seq
        );
        const claimed: RawInboxItem[] = [];
        for (const r of sorted) {
            if (claimed.length >= limit) break;
            const retryDue = r.status === 'retrying' && (!r.next_attempt_at || r.next_attempt_at <= nowIso);
            const claimExpired = r.status === 'processing' && r.claim_expires_at !== undefined && r.claim_expires_at <= nowIso;
            if (!retryDue && !claimExpired) continue;
            r.status = 'processing';
            r.claim_token = randomUUID();
            r.claim_expires_at = expiresIso;
            claimed.push({ ...r, raw: Buffer.from(r.raw) });
        }
        return claimed;
    }

    async markProcessed(messageId: string, claimToken?: string | undefined): Promise<boolean> {
        const r = this.records.get(messageId);
        if (!r) return false;
        if (claimToken && r.claim_token !== claimToken) return false;
        r.status = 'processed';
        r.retryable = false;
        delete r.claim_token;
        delete r.claim_expires_at;
        delete r.next_attempt_at;
        return true;
    }

    async markFailed(
        messageId: string,
        opts: { claimToken?: string | undefined; retryable: boolean; reason: string; maxAttempts: number; backoffMs?: number | undefined }
    ): Promise<void> {
        const r = this.records.get(messageId);
        if (!r) return;
        if (opts.claimToken && r.claim_token !== opts.claimToken) return;
        const nextAttempts = r.attempts + 1;
        const canRetry = opts.retryable && nextAttempts < opts.maxAttempts;
        r.attempts = nextAttempts;
        r.status = canRetry ? 'retrying' : 'parked';
        r.retryable = canRetry;
        r.reason = !opts.retryable ? opts.reason : canRetry ? opts.reason : `max_attempts_exceeded: ${opts.reason}`;
        if (canRetry) {
            r.next_attempt_at = new Date(Date.now() + (opts.backoffMs ?? computeBackoffWithJitter(nextAttempts))).toISOString();
        } else {
            delete r.next_attempt_at;
        }
        delete r.claim_token;
        delete r.claim_expires_at;
    }

    async hasBlockingFailure(source: string, sourceRefId: string, beforeSeq?: number): Promise<boolean> {
        for (const r of this.records.values()) {
            if (
                r.source === source &&
                r.source_ref_id === sourceRefId &&
                (r.status === 'retrying' || r.status === 'parked' || r.status === 'processing') &&
                (beforeSeq === undefined || r.created_seq < beforeSeq)
            ) {
                return true;
            }
        }
        return false;
    }

    async list(q: {
        source?: string | undefined;
        limit: number;
        cursor?: string | undefined;
    }): Promise<{ items: UnprocessedAuditItem[]; next_cursor: string | null }> {
        const c = q.cursor ? decodeCursor(q.cursor) : undefined;
        const items = [...this.records.values()]
            .filter((r) => (r.status === 'retrying' || r.status === 'parked') && (!q.source || r.source === q.source))
            .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.message_id.localeCompare(b.message_id))
            .filter((r) => !c || r.received_at > c.r || (r.received_at === c.r && r.message_id > c.m));

        const hasMore = items.length > q.limit;
        const slice = hasMore ? items.slice(0, q.limit) : items;
        const last = slice[slice.length - 1];
        return {
            items: slice.map(toAuditItem),
            next_cursor: hasMore && last ? encodeCursor(last.received_at, last.message_id) : null,
        };
    }

    async replay(filter: RawInboxFilter, handler: ReplayHandler, maxPerSecond: number, maxAttempts = 5): Promise<ReplayStats> {
        const items = [...this.records.values()]
            .filter((r) => (r.status === 'parked' || r.status === 'retrying'))
            .filter((r) => !filter.source || r.source === filter.source)
            .filter((r) => !filter.reason || (r.reason ?? '').includes(filter.reason))
            .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.created_seq - b.created_seq);
        return executeOrderedReplay(items, this, handler, maxPerSecond, maxAttempts);
    }

    async countsByStatus(): Promise<Record<InboxStatus, number>> {
        const counts: Record<InboxStatus, number> = { received: 0, processing: 0, processed: 0, retrying: 0, parked: 0 };
        for (const r of this.records.values()) counts[r.status] += 1;
        return counts;
    }

    getRawById(messageId: string): Buffer | undefined {
        return this.records.get(messageId)?.raw;
    }
}

async function executeOrderedReplay(
    items: RawInboxItem[],
    store: RawInboxStore,
    handler: ReplayHandler,
    maxPerSecond: number,
    maxAttempts: number
): Promise<ReplayStats> {
    const blockedKeys = new Set<string>();
    const stats: ReplayStats = { scanned: items.length, recovered: 0, blocked_by_key: 0, still_failed: 0 };
    const minSpacingMs = maxPerSecond > 0 ? Math.floor(1000 / maxPerSecond) : 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const key = item.source_ref_id ? `${item.source}\u0000${item.source_ref_id}` : undefined;
        if (key && blockedKeys.has(key)) {
            stats.blocked_by_key += 1;
            continue;
        }

        if (minSpacingMs > 0 && i > 0) {
            await new Promise((r) => setTimeout(r, minSpacingMs));
        }

        const result = await handler(item);
        if (result.ok) {
            await store.markProcessed(item.message_id);
            stats.recovered += 1;
        } else {
            await store.markFailed(item.message_id, {
                retryable: result.retryable,
                reason: result.reason,
                maxAttempts,
            });
            stats.still_failed += 1;
            if (key) blockedKeys.add(key);
        }
    }
    return stats;
}

function isDupKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}
