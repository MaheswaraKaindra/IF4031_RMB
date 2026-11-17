import { MongoClient, MongoWriteConcernError, type Collection, type Document, type Filter } from 'mongodb';
import { AnalyticsAccumulator } from './analytics.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { hazardIdFor } from './identity.js';
import { checksumOfRefs, sortKey } from './merge.js';
import type { StoreMember, StoreTopology } from './topology.js';
import type {
    AnalyticsQuery, AnalyticsResult, ChecksumResult, GlobalQuery, HazardRecord, ICanonicalRepository,
    IngestInput, IngestResult, LocateResult, Location, Page, Source, UnitStatus,
} from './types.js';

export interface MongoRepositoryOptions {
    client: MongoClient;            // connected to mongos (sharded) or the single mongod
    dbName?: string;
    topology?: StoreTopology | undefined;
    probeUser?: string | undefined;     // shard-local credentials for direct member reads
    probePassword?: string | undefined;
    deadlineMs?: number;            // every read is bounded by this (keep it below the caller's own timeout, e.g. client-api 2s)
    probeTimeoutMs?: number;        // per-member liveness probe; probes run in the BACKGROUND, queries only read the cache
    probeIntervalMs?: number;
    strictWrites?: boolean;         // true: a write-concern timeout is an UNKNOWN outcome (fail closed) instead of a degraded ack
    writeW?: number | 'majority';   // sharded layout: 2 (2 data members + arbiter; majority cannot be acked with one member down)
    writeTimeoutMs?: number;
}

const HAZARDS = 'hazards';

function normalizeIso(v: string): string {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function toRecord(doc: Document): HazardRecord {
    const { _id, event_version, fence_epoch, ...rest } = doc;
    void _id; void event_version; void fence_epoch;
    return rest as HazardRecord;
}

export class MongoCanonicalRepository implements ICanonicalRepository {
    private readonly client: MongoClient;
    private readonly dbName: string;
    private readonly topology: StoreTopology | undefined;
    private readonly deadlineMs: number;
    private readonly writeConcern: { w: number | 'majority'; wtimeout: number };
    private readonly memberClients = new Map<string, MongoClient>();
    private readonly probeMs: number;
    private statusCache: { at: number; value: UnitStatus[] } | undefined;
    private refreshing: Promise<UnitStatus[]> | undefined;
    private prober: NodeJS.Timeout | undefined;

    constructor(private readonly o: MongoRepositoryOptions) {
        this.client = o.client;
        this.dbName = o.dbName ?? 'bnpb_canonical_store';
        this.topology = o.topology;
        this.deadlineMs = o.deadlineMs ?? 3000;
        this.writeConcern = { w: o.writeW ?? 1, wtimeout: o.writeTimeoutMs ?? 1500 };
        this.probeMs = o.probeTimeoutMs ?? 500;
        if (this.topology) {
            // Liveness is measured continuously in the background so that a dead member never adds latency to a request.
            this.prober = setInterval(() => void this.refreshStatus(), o.probeIntervalMs ?? 2000);
            this.prober.unref();
            void this.refreshStatus();
        }
    }

    private hazards(): Collection<Document> {
        return this.client.db(this.dbName).collection(HAZARDS);
    }

    // ---- writes -------------------------------------------------------------------------------

    async ingest({ event, eventVersion, epoch }: IngestInput): Promise<IngestResult> {
        const id = hazardIdFor(event.source, event.source_ref_id);
        const { hazard_id: _h, ingested_at, ...rest } = event;
        void _h;
        const and: Filter<Document>[] = [];
        if (epoch !== undefined) and.push({ $or: [{ fence_epoch: { $exists: false } }, { fence_epoch: { $lte: epoch } }] });
        if (eventVersion !== undefined) and.push({ $or: [{ event_version: { $exists: false } }, { event_version: { $lt: eventVersion } }] });
        const filter: Filter<Document> = and.length ? { _id: id as never, $and: and } : { _id: id as never };

        const $set: Document = { ...rest, occurred_at: normalizeIso(event.occurred_at) };
        if (eventVersion !== undefined) $set['event_version'] = eventVersion;
        const update: Document = { $set, $setOnInsert: { hazard_id: id, ingested_at } };
        if (epoch !== undefined) update['$max'] = { fence_epoch: epoch };

        try {
            // Fence/version check and write are ONE conditional upsert: if the condition fails on an
            // existing record the upsert tries to insert the same _id and raises E11000 (below).
            const r = await this.hazards().updateOne(filter, update, { upsert: true, writeConcern: this.writeConcern });
            return { outcome: r.upsertedCount > 0 || r.modifiedCount > 0 ? 'applied' : 'duplicate', hazard_id: id, created: r.upsertedCount > 0 };
        } catch (err) {
            if (isDuplicateKey(err)) return this.classifyRejected(id, epoch, eventVersion);
            if (err instanceof MongoWriteConcernError && !this.o.strictWrites) {
                // wtimeout: the primary applied the write, only the second data member has not confirmed (it is down or
                // re-syncing). Refusing writes for the whole recovery window would stop ingestion; acknowledge it as
                // DEGRADED instead: durable on ONE copy until resync (see docs/consistency.md). Callers count/log `degraded`.
                return { outcome: 'applied', hazard_id: id, created: await this.wasCreatedBy(id, ingested_at), degraded: true, detail: errMsg(err) };
            }
            // Network / server-selection error, or strict mode: the write may or may not have happened.
            return { outcome: 'unavailable', hazard_id: id, detail: errMsg(err) };
        }
    }

    // After a write-concern timeout: was this call the one that inserted the record? Unknown -> true (a duplicate publish is
    // absorbed by consumer dedup; a missed publish would lose a notification).
    private async wasCreatedBy(id: string, ingestedAt: string): Promise<boolean> {
        try {
            const cur = await this.hazards().findOne({ _id: id as never }, { projection: { ingested_at: 1 }, maxTimeMS: this.deadlineMs, readPreference: 'primary' });
            return cur?.['ingested_at'] === ingestedAt;
        } catch {
            return true;
        }
    }

    private async classifyRejected(id: string, epoch: number | undefined, version: number | undefined): Promise<IngestResult> {
        try {
            const cur = await this.hazards().findOne({ _id: id as never }, { projection: { fence_epoch: 1, event_version: 1 }, maxTimeMS: this.deadlineMs });
            if (epoch !== undefined && typeof cur?.['fence_epoch'] === 'number' && cur['fence_epoch'] > epoch) return { outcome: 'stale_epoch', hazard_id: id };
            if (version !== undefined && typeof cur?.['event_version'] === 'number' && cur['event_version'] > version) return { outcome: 'stale_version', hazard_id: id };
            return { outcome: 'duplicate', hazard_id: id };
        } catch (err) {
            return { outcome: 'unavailable', hazard_id: id, detail: errMsg(err) };
        }
    }

    async remove(id: string, epoch?: number): Promise<IngestResult> {
        const filter: Filter<Document> = epoch === undefined
            ? { _id: id as never }
            : { _id: id as never, $or: [{ fence_epoch: { $exists: false } }, { fence_epoch: { $lte: epoch } }] };
        try {
            const r = await this.hazards().deleteOne(filter, { writeConcern: this.writeConcern });
            if (r.deletedCount > 0) return { outcome: 'applied', hazard_id: id };
            if (epoch !== undefined) {
                const cur = await this.hazards().findOne({ _id: id as never }, { projection: { fence_epoch: 1 }, maxTimeMS: this.deadlineMs });
                if (cur && typeof cur['fence_epoch'] === 'number' && cur['fence_epoch'] > epoch) return { outcome: 'stale_epoch', hazard_id: id };
            }
            return { outcome: 'duplicate', hazard_id: id };
        } catch (err) {
            return { outcome: 'unavailable', hazard_id: id, detail: errMsg(err) };
        }
    }

    // ---- reads --------------------------------------------------------------------------------

    async getById(id: string): Promise<HazardRecord | null> {
        const doc = await this.hazards().findOne({ _id: id as never }, { maxTimeMS: this.deadlineMs, readPreference: 'primaryPreferred' });
        return doc ? toRecord(doc) : null;
    }

    async queryGlobal(q: GlobalQuery): Promise<Page<HazardRecord>> {
        const f = q.filter ?? {};
        const keyField = q.sort === 'occurred_desc' ? 'occurred_at' : 'ingested_at';
        const and: Filter<Document>[] = [];
        const base: Filter<Document> = {};
        if (f.source) base['source'] = f.source;
        if (f.hazard_type) base['hazard_type'] = f.hazard_type;
        if (f.severity) base['severity'] = f.severity;
        if (f.since) base[keyField] = { $gte: f.since };
        if (q.cursor) {
            const c = decodeCursor(q.cursor, q.sort);
            const cmp = q.sort === 'occurred_desc' ? '$lt' : '$gt';
            and.push({ $or: [{ [keyField]: { [cmp]: c.k } }, { [keyField]: c.k, hazard_id: { $gt: c.h } }] });
        }
        const filter: Filter<Document> = and.length ? { $and: [base, ...and] } : base;
        const sort = q.sort === 'occurred_desc' ? { occurred_at: -1, hazard_id: 1 } : { ingested_at: 1, hazard_id: 1 };

        const probe = this.unitStatus();
        try {
            const docs = await this.hazards()
                .find(filter, { allowPartialResults: true, maxTimeMS: this.deadlineMs, readPreference: 'primaryPreferred' })
                .sort(sort as never).limit(q.limit + 1).toArray();
            const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
            const items = docs.slice(0, q.limit).map(toRecord);
            const last = items[items.length - 1];
            return {
                items,
                next_cursor: docs.length > q.limit && last ? encodeCursor({ s: q.sort, k: sortKey(last, q.sort), h: last.hazard_id }) : null,
                partial: un.length > 0,
                unavailable_units: un,
            };
        } catch (err) {
            if (err instanceof Error && err.message === 'invalid cursor') throw err;
            const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
            return { items: [], next_cursor: q.cursor ?? null, partial: true, unavailable_units: un.length ? un : ['store-router'] };
        }
    }

    // Aggregation runs in the app over a projection so the same `allowPartialResults` + probe path decides
    // partial-ness, and mongos filters orphaned documents during chunk migration. O(N) in records: fine for
    // the demo dataset; swap for $group pipelines (healthy case) if the dataset grows by orders of magnitude.
    async aggregate(q: AnalyticsQuery): Promise<AnalyticsResult> {
        const acc = new AnalyticsAccumulator(q);
        const filter: Filter<Document> = {};
        if (q.from || q.to) filter['occurred_at'] = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
        const probe = this.unitStatus();
        let failed = false;
        try {
            const cursor = this.hazards().find(filter, {
                allowPartialResults: true, maxTimeMS: this.deadlineMs * 10, readPreference: 'primaryPreferred',
                projection: { hazard_type: 1, severity: 1, area_name: 1, occurred_at: 1, 'attributes.potential_tsunami': 1, 'attributes.tsunami_warning': 1 },
            });
            for await (const d of cursor) acc.add(d as never);
        } catch {
            failed = true;
        }
        const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
        return acc.result(failed || un.length > 0, failed && !un.length ? ['store-router'] : un);
    }

    async checksum(source?: Source): Promise<ChecksumResult> {
        const refs: string[] = [];
        const probe = this.unitStatus();
        let failed = false;
        try {
            const cursor = this.hazards().find(source ? { source } : {}, {
                allowPartialResults: true, maxTimeMS: this.deadlineMs * 10, readPreference: 'primaryPreferred', projection: { source_ref_id: 1 },
            });
            for await (const d of cursor) refs.push(String(d['source_ref_id']));
        } catch {
            failed = true;
        }
        const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
        return {
            source: source ?? 'ALL', count: refs.length, checksum: checksumOfRefs(refs), algorithm: 'sha256',
            as_of: new Date().toISOString(), partial: failed || un.length > 0, unavailable_units: failed && !un.length ? ['store-router'] : un,
        };
    }

    // ---- placement visibility -------------------------------------------------------------------

    private memberClient(m: StoreMember, auth: boolean): MongoClient {
        const key = `${m.host}|${auth}`;
        let c = this.memberClients.get(key);
        if (!c) {
            const cred = auth && this.o.probeUser ? `${encodeURIComponent(this.o.probeUser)}:${encodeURIComponent(this.o.probePassword ?? '')}@` : '';
            const t = auth ? this.deadlineMs : this.probeMs;
            const params = `directConnection=true&serverSelectionTimeoutMS=${t}&connectTimeoutMS=${t}${auth && cred ? '&authSource=admin' : ''}`;
            c = new MongoClient(`mongodb://${cred}${m.host}:27017/?${params}`);
            this.memberClients.set(key, c);
        }
        return c;
    }

    private async hello(m: StoreMember): Promise<{ reachable: boolean; primary: boolean; secondary: boolean }> {
        try {
            const r = await this.memberClient(m, false).db('admin').command({ hello: 1 }, { timeoutMS: this.probeMs });
            return { reachable: true, primary: r['isWritablePrimary'] === true, secondary: r['secondary'] === true };
        } catch {
            return { reachable: false, primary: false, secondary: false };
        }
    }

    // A unit is available for READS when at least one data-bearing member is a reachable primary or secondary.
    // Served from a cache refreshed in the background (every ~2s, 500ms probe timeout): never on the request path.
    async unitStatus(): Promise<UnitStatus[]> {
        if (!this.topology) return [{ unit: 'mongo', available: true }];
        if (this.statusCache && Date.now() - this.statusCache.at < 10_000) return this.statusCache.value;
        return this.refreshStatus();
    }

    private refreshStatus(): Promise<UnitStatus[]> {
        const topology = this.topology;
        if (!topology) return Promise.resolve([{ unit: 'mongo', available: true }]);
        this.refreshing ??= Promise.all(topology.units.map(async (u): Promise<UnitStatus> => {
            const data = u.members.filter((m) => !m.arbiter);
            const hellos = await Promise.all(data.map((m) => this.hello(m)));
            const ok = hellos.some((h) => h.primary || h.secondary);
            return { unit: u.name, available: ok, detail: ok ? undefined : 'no readable data member' };
        })).then((value) => {
            this.statusCache = { at: Date.now(), value };
            return value;
        }).finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }

    async locate(id: string): Promise<LocateResult | null> {
        const doc = await this.getById(id).catch(() => null);
        const status = await this.unitStatus();
        const down = status.filter((s) => !s.available);
        if (!doc) return down.length ? { hazard_id: id, locations: [], partial: true } : null;
        if (!this.topology) return { hazard_id: id, locations: [{ node: 'single-node', unit: 'mongo', role: 'primary' }], partial: false };

        const unitName = await this.shardOf(id);
        const units = unitName ? this.topology.units.filter((u) => u.name === unitName) : this.topology.units;
        const locations: Location[] = [];
        await Promise.all(units.flatMap((u) => u.members.filter((m) => !m.arbiter).map(async (m) => {
            const h = await this.hello(m);
            if (!h.reachable) return;
            try {
                const c = this.memberClient(m, true);
                const found = await c.db(this.dbName).collection(HAZARDS).findOne(
                    { _id: id as never }, { projection: { _id: 1 }, maxTimeMS: this.deadlineMs, readPreference: 'secondaryPreferred' });
                if (found) locations.push({ node: m.node, unit: u.name, role: h.primary ? 'primary' : 'replica' });
            } catch { /* member unreadable: not listed as a holder */ }
        })));
        locations.sort((a, b) => (a.role === b.role ? a.node.localeCompare(b.node) : a.role === 'primary' ? -1 : 1));
        return { hazard_id: id, locations, partial: down.length > 0 && locations.length === 0 };
    }

    private async shardOf(id: string): Promise<string | undefined> {
        try {
            const r = await this.client.db(this.dbName).command(
                { explain: { find: HAZARDS, filter: { _id: id } }, verbosity: 'queryPlanner' }, { timeoutMS: this.deadlineMs });
            const shards = r['queryPlanner']?.['winningPlan']?.['shards'] as Array<{ shardName?: string }> | undefined;
            return shards?.[0]?.shardName;
        } catch {
            return undefined;
        }
    }

    // Per-node holdings and write load for the P1 distribution report (tools/store-tool.ts).
    async distribution(): Promise<Array<{ unit: string; node: string; member: string; role: string; count: number | null; inserts: number | null; updates: number | null }>> {
        if (!this.topology) return [];
        const rows = await Promise.all(this.topology.units.flatMap((u) => u.members.filter((m) => !m.arbiter).map(async (m) => {
            const h = await this.hello(m);
            const role = h.primary ? 'primary' : h.secondary ? 'secondary' : 'down';
            if (!h.reachable) return { unit: u.name, node: m.node, member: m.name, role, count: null, inserts: null, updates: null };
            try {
                const c = this.memberClient(m, true);
                const count = await c.db(this.dbName).collection(HAZARDS).countDocuments({}, { maxTimeMS: this.deadlineMs * 10, readPreference: 'secondaryPreferred' } as never);
                const st = await c.db('admin').command({ serverStatus: 1 });
                return { unit: u.name, node: m.node, member: m.name, role, count, inserts: Number(st['opcounters']?.['insert'] ?? 0), updates: Number(st['opcounters']?.['update'] ?? 0) };
            } catch {
                return { unit: u.name, node: m.node, member: m.name, role, count: null, inserts: null, updates: null };
            }
        })));
        return rows;
    }

    async close(): Promise<void> {
        if (this.prober) clearInterval(this.prober);
        await Promise.all([...this.memberClients.values()].map((c) => c.close().catch(() => undefined)));
    }
}

function isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
