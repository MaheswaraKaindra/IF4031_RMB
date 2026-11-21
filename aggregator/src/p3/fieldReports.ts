import { createHash, randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { ICanonicalRepository } from '../storage/types.js';
import type { HazardEvent } from '../utils/mapper.js';
import { computeBackoffWithJitter } from './rawInbox.js';
import { mapFieldReportToHazard, validateFieldReport } from './schemaValidator.js';
import { bookkeepingOptions } from '../storage/health.js';
import { startChildSpan } from '../observability.js';

export type OutboxStatus = 'pending' | 'published';

export interface FieldReportOutboxRecord {
    _id: string; // `${principal}:${idempotency_key}`
    report_id: string;
    principal: string;
    idempotency_key: string;
    payload_sha256: string;
    hazard_event: HazardEvent & { source: 'FIELD_REPORT' };
    canonical_applied: boolean;
    outbox_status: OutboxStatus;
    correlation_id: string;
    traceparent?: string | undefined;
    attempts: number;
    next_attempt_at: string;
    claim_token?: string | undefined;
    claim_expires_at?: string | undefined;
    created_at: string;
    published_at?: string | undefined;
}

export type AcceptFieldReportResult =
    | { status: 202; report_id: string; hazard_id: string; duplicate: boolean }
    | { status: 400; code: 'bad_request'; message: string }
    | { status: 409; code: 'idempotency_conflict'; message: string }
    | { status: 503; code: 'unavailable'; message: string };

export interface FieldReportStore {
    accept(input: {
        body: unknown;
        principal: string;
        idempotencyKey?: string | undefined;
        correlationId: string;
        traceparent?: string | undefined;
    }): Promise<AcceptFieldReportResult>;
    claimPending(limit: number, visibilityMs: number): Promise<FieldReportOutboxRecord[]>;
    markCanonicalApplied(id: string, claimToken: string): Promise<void>;
    markPublished(id: string, claimToken: string): Promise<void>;
    markRelayFailed(id: string, claimToken: string): Promise<void>;
    pendingCount(): Promise<number>;
}

function payloadDigest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export class MongoFieldReportOutbox implements FieldReportStore {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'field_reports_outbox') {}

    private coll(): Collection<FieldReportOutboxRecord> {
        return this.getDb().collection<FieldReportOutboxRecord>(this.collectionName, bookkeepingOptions());
    }

    async ensureIndexes(): Promise<void> {
        await this.coll().createIndex({ outbox_status: 1, next_attempt_at: 1, claim_expires_at: 1 });
        await this.coll().createIndex({ report_id: 1 });
    }

    async accept(input: {
        body: unknown;
        principal: string;
        idempotencyKey?: string | undefined;
        correlationId: string;
        traceparent?: string | undefined;
    }): Promise<AcceptFieldReportResult> {
        const parsed = validateFieldReport(input.body);
        if (!parsed.ok) {
            return { status: 400, code: 'bad_request', message: parsed.reason };
        }

        const key = input.idempotencyKey?.trim() || parsed.value.report_id;
        const docId = `${input.principal}:${key}`;
        const digest = payloadDigest(parsed.value);
        const hazardEvent = mapFieldReportToHazard(parsed.value, input.principal);
        const now = new Date().toISOString();

        const record: FieldReportOutboxRecord = {
            _id: docId,
            report_id: parsed.value.report_id,
            principal: input.principal,
            idempotency_key: key,
            payload_sha256: digest,
            hazard_event: hazardEvent,
            canonical_applied: false,
            outbox_status: 'pending',
            correlation_id: input.correlationId,
            ...(input.traceparent ? { traceparent: input.traceparent } : {}),
            attempts: 0,
            next_attempt_at: now,
            created_at: now,
        };

        try {
            const storeSpan = startChildSpan('store accept field report', input.traceparent, 'CLIENT', { hazard_id: hazardEvent.hazard_id, 'x-correlation-id': input.correlationId });
            try {
                await this.coll().insertOne(record);
                storeSpan.end(true);
            } catch (e) {
                storeSpan.end(!isDupKey(e), { duplicate: isDupKey(e) ? 1 : 0 });
                throw e;
            }
            return { status: 202, report_id: record.report_id, hazard_id: hazardEvent.hazard_id, duplicate: false };
        } catch (err) {
            if (isDupKey(err)) {
                try {
                    const existing = await this.coll().findOne({ _id: docId });
                    if (existing) {
                        if (existing.payload_sha256 !== digest) {
                            return {
                                status: 409,
                                code: 'idempotency_conflict',
                                message: 'Idempotency key was already used with a different payload',
                            };
                        }
                        return {
                            status: 202,
                            report_id: existing.report_id,
                            hazard_id: existing.hazard_event.hazard_id,
                            duplicate: true,
                        };
                    }
                } catch {
                    return { status: 503, code: 'unavailable', message: 'Storage unavailable during idempotency check' };
                }
            }
            return { status: 503, code: 'unavailable', message: 'Storage unavailable, acceptance not guaranteed' };
        }
    }

    async claimPending(limit: number, visibilityMs: number): Promise<FieldReportOutboxRecord[]> {
        const claimed: FieldReportOutboxRecord[] = [];
        const nowIso = new Date().toISOString();
        const expiresIso = new Date(Date.now() + visibilityMs).toISOString();

        for (let i = 0; i < limit; i++) {
            const claimToken = randomUUID();
            const doc = await this.coll().findOneAndUpdate(
                {
                    outbox_status: 'pending',
                    next_attempt_at: { $lte: nowIso },
                    $or: [{ claim_expires_at: { $exists: false } }, { claim_expires_at: { $lte: nowIso } }],
                },
                {
                    $set: { claim_token: claimToken, claim_expires_at: expiresIso },
                },
                { sort: { created_at: 1 }, returnDocument: 'after' }
            );
            if (!doc) break;
            claimed.push(doc);
        }
        return claimed;
    }

    async markCanonicalApplied(id: string, claimToken: string): Promise<void> {
        await this.coll().updateOne({ _id: id, claim_token: claimToken }, { $set: { canonical_applied: true } });
    }

    async markPublished(id: string, claimToken: string): Promise<void> {
        await this.coll().updateOne(
            { _id: id, claim_token: claimToken },
            {
                $set: { outbox_status: 'published', published_at: new Date().toISOString() },
                $unset: { claim_token: '', claim_expires_at: '' },
            }
        );
    }

    async markRelayFailed(id: string, claimToken: string): Promise<void> {
        const cur = await this.coll().findOne({ _id: id, claim_token: claimToken });
        if (!cur) return;
        const attempts = cur.attempts + 1;
        const nextIso = new Date(Date.now() + computeBackoffWithJitter(attempts, 500, 15_000)).toISOString();
        await this.coll().updateOne(
            { _id: id, claim_token: claimToken },
            {
                $set: { attempts, next_attempt_at: nextIso },
                $unset: { claim_token: '', claim_expires_at: '' },
            }
        );
    }

    async pendingCount(): Promise<number> {
        return this.coll().countDocuments({ outbox_status: 'pending' });
    }
}

export class InMemoryFieldReportOutbox implements FieldReportStore {
    private readonly records = new Map<string, FieldReportOutboxRecord>();

    async accept(input: {
        body: unknown;
        principal: string;
        idempotencyKey?: string | undefined;
        correlationId: string;
        traceparent?: string | undefined;
    }): Promise<AcceptFieldReportResult> {
        const parsed = validateFieldReport(input.body);
        if (!parsed.ok) return { status: 400, code: 'bad_request', message: parsed.reason };

        const key = input.idempotencyKey?.trim() || parsed.value.report_id;
        const docId = `${input.principal}:${key}`;
        const digest = payloadDigest(parsed.value);
        const existing = this.records.get(docId);
        if (existing) {
            if (existing.payload_sha256 !== digest) {
                return { status: 409, code: 'idempotency_conflict', message: 'Idempotency key was already used with a different payload' };
            }
            return { status: 202, report_id: existing.report_id, hazard_id: existing.hazard_event.hazard_id, duplicate: true };
        }

        const hazardEvent = mapFieldReportToHazard(parsed.value, input.principal);
        const now = new Date().toISOString();
        this.records.set(docId, {
            _id: docId,
            report_id: parsed.value.report_id,
            principal: input.principal,
            idempotency_key: key,
            payload_sha256: digest,
            hazard_event: hazardEvent,
            canonical_applied: false,
            outbox_status: 'pending',
            correlation_id: input.correlationId,
            traceparent: input.traceparent,
            attempts: 0,
            next_attempt_at: now,
            created_at: now,
        });
        return { status: 202, report_id: parsed.value.report_id, hazard_id: hazardEvent.hazard_id, duplicate: false };
    }

    async claimPending(limit: number, visibilityMs: number): Promise<FieldReportOutboxRecord[]> {
        const nowIso = new Date().toISOString();
        const expiresIso = new Date(Date.now() + visibilityMs).toISOString();
        const out: FieldReportOutboxRecord[] = [];
        for (const r of this.records.values()) {
            if (out.length >= limit) break;
            if (r.outbox_status !== 'pending' || r.next_attempt_at > nowIso) continue;
            if (r.claim_expires_at && r.claim_expires_at > nowIso) continue;
            r.claim_token = randomUUID();
            r.claim_expires_at = expiresIso;
            out.push({ ...r });
        }
        return out;
    }

    async markCanonicalApplied(id: string, claimToken: string): Promise<void> {
        const r = this.records.get(id);
        if (r && r.claim_token === claimToken) r.canonical_applied = true;
    }

    async markPublished(id: string, claimToken: string): Promise<void> {
        const r = this.records.get(id);
        if (r && r.claim_token === claimToken) {
            r.outbox_status = 'published';
            r.published_at = new Date().toISOString();
            delete r.claim_token;
            delete r.claim_expires_at;
        }
    }

    async markRelayFailed(id: string, claimToken: string): Promise<void> {
        const r = this.records.get(id);
        if (!r || r.claim_token !== claimToken) return;
        r.attempts += 1;
        r.next_attempt_at = new Date(Date.now() + 100).toISOString();
        delete r.claim_token;
        delete r.claim_expires_at;
    }

    async pendingCount(): Promise<number> {
        let count = 0;
        for (const r of this.records.values()) if (r.outbox_status === 'pending') count++;
        return count;
    }

    getRecord(principal: string, key: string): FieldReportOutboxRecord | undefined {
        return this.records.get(`${principal}:${key}`);
    }
}

export interface OutboxPublisher {
    publishConfirmed(record: FieldReportOutboxRecord): Promise<void>;
}

/**
 * Relays durably accepted field reports to both the canonical store and RabbitMQ (with Publisher Confirms).
 * Crash-safe at every boundary: pre-canonical, post-canonical/pre-publish, and post-publish/pre-mark.
 */
export async function relayPendingOutboxBatch(
    store: FieldReportStore,
    repo: ICanonicalRepository,
    publisher: OutboxPublisher,
    batchSize = 20,
    visibilityMs = 10_000
): Promise<{ claimed: number; published: number; failed: number }> {
    const claimed = await store.claimPending(batchSize, visibilityMs);
    let published = 0;
    let failed = 0;

    for (const item of claimed) {
        const token = item.claim_token!;
        try {
            if (!item.canonical_applied) {
                const res = await repo.ingest({ event: item.hazard_event as never });
                if (res.outcome === 'unavailable') {
                    await store.markRelayFailed(item._id, token);
                    failed++;
                    continue;
                }
                await store.markCanonicalApplied(item._id, token);
            }
            await publisher.publishConfirmed(item);
            await store.markPublished(item._id, token);
            published++;
        } catch {
            await store.markRelayFailed(item._id, token);
            failed++;
        }
    }
    return { claimed: claimed.length, published, failed };
}

function isDupKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}
