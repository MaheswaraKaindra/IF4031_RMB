import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { HazardRecord } from '../storage/types.js';

export const RECEIVER = 'field-team';

export type DeliveryState = 'pending' | 'published' | 'delivered';

export interface DeliveryEntry {
    _id: string; // delivery key: `${hazard_id}:${receiver}`
    hazard_id: string;
    receiver: string;
    event: HazardRecord;
    state: DeliveryState;
    canonical_applied: boolean;
    ingress_at: Date; // store clock, set once
    published_at?: Date | undefined;
    delivered_at?: Date | undefined;
    attempts: number;
    traceparent?: string | undefined;
    next_attempt_at: Date;
    claim_token?: string | undefined;
    claim_expires_at?: Date | undefined;
}

export interface AckResult {
    first: boolean;
    latencyMs: number | null;
    known: boolean;
}

export interface LedgerCounts {
    pending: number;
    published: number;
    delivered: number;
    oldestUndeliveredMs: number;
}

export interface DeliveryReport {
    expected: number;
    delivered: number;
    undelivered: number;
    withinDeadline: number;
    deadlineMisses: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
}

export interface IDeliveryLedger {
    register(event: HazardRecord, traceparent?: string): Promise<{ id: string; created: boolean }>;
    markCanonicalApplied(id: string): Promise<void>;
    claim(limit: number, visibilityMs: number): Promise<DeliveryEntry[]>;
    markPublished(id: string, claimToken: string, redeliverAfterMs: number): Promise<void>;
    release(id: string, claimToken: string, retryInMs: number): Promise<void>;
    ack(hazardId: string, receiver: string): Promise<AckResult>;
    counts(): Promise<LedgerCounts>;
    report(deadlineMs: number): Promise<DeliveryReport>;
}

export const deliveryKey = (hazardId: string, receiver = RECEIVER): string => `${hazardId}:${receiver}`;

// Redelivery of an unacknowledged entry backs off, so a receiver that is down is not hit faster as the backlog grows.
export function redeliverDelayMs(attempts: number, baseMs = 5000, maxMs = 60_000): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

export function summarize(entries: readonly DeliveryEntry[], deadlineMs: number, nowMs: number): DeliveryReport {
    const lat: number[] = [];
    let withinDeadline = 0;
    let misses = 0;
    for (const e of entries) {
        if (e.delivered_at) {
            const ms = e.delivered_at.getTime() - e.ingress_at.getTime();
            lat.push(ms);
            if (ms <= deadlineMs) withinDeadline++;
            else misses++;
        } else if (nowMs - e.ingress_at.getTime() > deadlineMs) misses++;
    }
    lat.sort((a, b) => a - b);
    const pct = (p: number): number | null => (lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)]!);
    return {
        expected: entries.length,
        delivered: lat.length,
        undelivered: entries.length - lat.length,
        withinDeadline,
        deadlineMisses: misses,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        maxMs: lat.length ? lat[lat.length - 1]! : null,
    };
}

export class InMemoryDeliveryLedger implements IDeliveryLedger {
    readonly entries = new Map<string, DeliveryEntry>();
    constructor(private readonly now: () => number = Date.now) {}

    async register(event: HazardRecord, traceparent?: string): Promise<{ id: string; created: boolean }> {
        const id = deliveryKey(event.hazard_id);
        if (this.entries.has(id)) return { id, created: false };
        this.entries.set(id, {
            _id: id,
            hazard_id: event.hazard_id,
            receiver: RECEIVER,
            event,
            state: 'pending',
            canonical_applied: false,
            ingress_at: new Date(this.now()),
            attempts: 0,
            traceparent,
            next_attempt_at: new Date(this.now()),
        });
        return { id, created: true };
    }

    async markCanonicalApplied(id: string): Promise<void> {
        const e = this.entries.get(id);
        if (e) e.canonical_applied = true;
    }

    async claim(limit: number, visibilityMs: number): Promise<DeliveryEntry[]> {
        const t = this.now();
        const out: DeliveryEntry[] = [];
        for (const e of this.entries.values()) {
            if (out.length >= limit) break;
            if (e.state === 'delivered' || !e.canonical_applied) continue;
            if (e.next_attempt_at.getTime() > t) continue;
            if (e.claim_expires_at && e.claim_expires_at.getTime() > t) continue;
            e.claim_token = randomUUID();
            e.claim_expires_at = new Date(t + visibilityMs);
            e.attempts++;
            out.push({ ...e });
        }
        return out;
    }

    async markPublished(id: string, claimToken: string, redeliverAfterMs: number): Promise<void> {
        const e = this.entries.get(id);
        if (!e || e.claim_token !== claimToken) return;
        if (e.state === 'pending') e.state = 'published';
        e.published_at ??= new Date(this.now());
        e.next_attempt_at = new Date(this.now() + redeliverAfterMs);
        e.claim_token = undefined;
        e.claim_expires_at = undefined;
    }

    async release(id: string, claimToken: string, retryInMs: number): Promise<void> {
        const e = this.entries.get(id);
        if (!e || e.claim_token !== claimToken) return;
        e.next_attempt_at = new Date(this.now() + retryInMs);
        e.claim_token = undefined;
        e.claim_expires_at = undefined;
    }

    async ack(hazardId: string, receiver: string): Promise<AckResult> {
        const e = this.entries.get(deliveryKey(hazardId, receiver));
        if (!e) return { first: false, latencyMs: null, known: false };
        if (e.delivered_at) return { first: false, latencyMs: e.delivered_at.getTime() - e.ingress_at.getTime(), known: true };
        e.delivered_at = new Date(this.now());
        e.state = 'delivered';
        return { first: true, latencyMs: e.delivered_at.getTime() - e.ingress_at.getTime(), known: true };
    }

    async counts(): Promise<LedgerCounts> {
        const c: LedgerCounts = { pending: 0, published: 0, delivered: 0, oldestUndeliveredMs: 0 };
        const t = this.now();
        for (const e of this.entries.values()) {
            c[e.state]++;
            if (e.state !== 'delivered') c.oldestUndeliveredMs = Math.max(c.oldestUndeliveredMs, t - e.ingress_at.getTime());
        }
        return c;
    }

    async report(deadlineMs: number): Promise<DeliveryReport> {
        return summarize([...this.entries.values()], deadlineMs, this.now());
    }
}

// Timestamps that decide the latency (ingress_at, published_at, delivered_at) come from the store clock ($$NOW), so a
// skewed node clock cannot distort the measured latency or the deadline accounting.
export class MongoDeliveryLedger implements IDeliveryLedger {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'coastal_deliveries') {}

    private coll(): Collection<DeliveryEntry> {
        return this.getDb().collection<DeliveryEntry>(this.collectionName);
    }

    async ensureIndexes(): Promise<void> {
        await this.coll().createIndex({ state: 1, canonical_applied: 1, next_attempt_at: 1 });
        await this.coll().createIndex({ ingress_at: 1 });
    }

    async register(event: HazardRecord, traceparent?: string): Promise<{ id: string; created: boolean }> {
        const id = deliveryKey(event.hazard_id);
        const res = await this.coll().updateOne(
            { _id: id },
            [
                {
                    $set: {
                        hazard_id: { $ifNull: ['$hazard_id', event.hazard_id] },
                        receiver: { $ifNull: ['$receiver', RECEIVER] },
                        event: { $ifNull: ['$event', event] },
                        state: { $ifNull: ['$state', 'pending'] },
                        canonical_applied: { $ifNull: ['$canonical_applied', false] },
                        ingress_at: { $ifNull: ['$ingress_at', '$$NOW'] },
                        attempts: { $ifNull: ['$attempts', 0] },
                        traceparent: { $ifNull: ['$traceparent', traceparent ?? null] },
                        next_attempt_at: { $ifNull: ['$next_attempt_at', '$$NOW'] },
                    },
                },
            ],
            { upsert: true }
        );
        return { id, created: res.upsertedCount > 0 };
    }

    async markCanonicalApplied(id: string): Promise<void> {
        await this.coll().updateOne({ _id: id }, { $set: { canonical_applied: true } });
    }

    async claim(limit: number, visibilityMs: number): Promise<DeliveryEntry[]> {
        const out: DeliveryEntry[] = [];
        for (let i = 0; i < limit; i++) {
            const token = randomUUID();
            const doc = await this.coll().findOneAndUpdate(
                {
                    state: { $in: ['pending', 'published'] },
                    canonical_applied: true,
                    $expr: { $lte: ['$next_attempt_at', '$$NOW'] },
                    $or: [{ claim_expires_at: { $exists: false } }, { claim_expires_at: null }, { $expr: { $lte: ['$claim_expires_at', '$$NOW'] } }],
                } as never,
                [
                    {
                        $set: {
                            claim_token: token,
                            claim_expires_at: { $add: ['$$NOW', visibilityMs] },
                            attempts: { $add: ['$attempts', 1] },
                        },
                    },
                ],
                { sort: { ingress_at: 1 }, returnDocument: 'after' }
            );
            if (!doc) break;
            out.push(doc);
        }
        return out;
    }

    async markPublished(id: string, claimToken: string, redeliverAfterMs: number): Promise<void> {
        await this.coll().updateOne({ _id: id, claim_token: claimToken }, [
            {
                $set: {
                    state: { $cond: [{ $eq: ['$state', 'pending'] }, 'published', '$state'] },
                    published_at: { $ifNull: ['$published_at', '$$NOW'] },
                    next_attempt_at: { $add: ['$$NOW', redeliverAfterMs] },
                },
            },
            { $unset: ['claim_token', 'claim_expires_at'] },
        ]);
    }

    async release(id: string, claimToken: string, retryInMs: number): Promise<void> {
        await this.coll().updateOne({ _id: id, claim_token: claimToken }, [
            { $set: { next_attempt_at: { $add: ['$$NOW', retryInMs] } } },
            { $unset: ['claim_token', 'claim_expires_at'] },
        ]);
    }

    async ack(hazardId: string, receiver: string): Promise<AckResult> {
        const id = deliveryKey(hazardId, receiver);
        const before = await this.coll().findOneAndUpdate(
            { _id: id, state: { $ne: 'delivered' } },
            [{ $set: { state: 'delivered', delivered_at: '$$NOW' } }, { $unset: ['claim_token', 'claim_expires_at'] }],
            { returnDocument: 'after' }
        );
        if (before?.delivered_at) return { first: true, latencyMs: before.delivered_at.getTime() - before.ingress_at.getTime(), known: true };
        const existing = await this.coll().findOne({ _id: id });
        if (!existing) return { first: false, latencyMs: null, known: false };
        return {
            first: false,
            latencyMs: existing.delivered_at ? existing.delivered_at.getTime() - existing.ingress_at.getTime() : null,
            known: true,
        };
    }

    async counts(): Promise<LedgerCounts> {
        const rows = await this.coll()
            .aggregate<{ _id: DeliveryState; c: number }>([{ $group: { _id: '$state', c: { $sum: 1 } } }])
            .toArray();
        const c: LedgerCounts = { pending: 0, published: 0, delivered: 0, oldestUndeliveredMs: 0 };
        for (const r of rows) c[r._id] = r.c;
        const oldest = await this.coll()
            .aggregate<{ age: number }>([
                { $match: { state: { $ne: 'delivered' } } },
                { $group: { _id: null, first: { $min: '$ingress_at' } } },
                { $project: { age: { $subtract: ['$$NOW', '$first'] } } },
            ])
            .toArray();
        c.oldestUndeliveredMs = oldest[0]?.age ?? 0;
        return c;
    }

    async report(deadlineMs: number): Promise<DeliveryReport> {
        const entries = await this.coll().find({}, { projection: { event: 0 } }).toArray();
        const nowRow = await this.coll()
            .aggregate<{ now: Date }>([{ $limit: 1 }, { $project: { now: '$$NOW' } }])
            .toArray();
        return summarize(entries as DeliveryEntry[], deadlineMs, nowRow[0]?.now.getTime() ?? Date.now());
    }
}
