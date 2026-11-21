import { MongoClient, MongoWriteConcernError, type Collection, type Document, type Filter } from 'mongodb';
import { logger } from '../logger.js';
import { isStoreDegraded, setStoreDegraded } from './health.js';
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
    scanDeadlineMs?: number;        // budget of one full scan (analytics, checksum); beyond it the answer is reported partial
    scanPageSize?: number;          // records per keyset page of a full scan (tests use a tiny value to cross many pages)
    probeTimeoutMs?: number;        // per-member liveness probe; probes run in the BACKGROUND, queries only read the cache
    probeIntervalMs?: number;
    strictWrites?: boolean;         // true: a write-concern timeout is an UNKNOWN outcome (fail closed) instead of a degraded ack
    writeW?: number | 'majority';   // sharded layout: 2 (2 data members + arbiter; majority cannot be acked with one member down)
    writeTimeoutMs?: number;
    // Who stamps ingested_at on first insert. 'store' (default): the database clock, so a skewed aggregator node cannot write
    // records dated in the future. 'caller': the value in the record (deterministic ordering in tests).
    ingestedAtSource?: 'store' | 'caller';
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
    private topology: StoreTopology | undefined;
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
        // Must stay clearly above the driver's 500ms minimum re-check interval, otherwise a member that comes back can fail
        // server selection forever.
        this.probeMs = o.probeTimeoutMs ?? 1500;
        if (this.topology) {
            // Measured in the background so that a dead member never adds latency to a request.
            this.prober = setInterval(() => void this.refreshStatus(), o.probeIntervalMs ?? 2000);
            this.prober.unref();
            void this.refreshStatus();
        }
    }

    // Node names change when a slot moves to a replacement machine (scripts/k8s/p1-replace-node.sh); member hosts are
    // stable DNS names, so connections and probes are unaffected. Only placement answers (/location, report) change.
    setTopology(t: StoreTopology): void {
        if (this.topology) this.topology = t;
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

        // Aggregation-pipeline update so the stamp can use the server clock ($$NOW). Every value goes through $literal: in a
        // pipeline a string starting with '$' would otherwise be read as a field path.
        const lit = (v: unknown): Document => ({ $literal: v });
        const stamp: unknown = this.o.ingestedAtSource === 'caller'
            ? lit(ingested_at)
            : { $dateToString: { date: '$$NOW', format: '%Y-%m-%dT%H:%M:%S.%LZ', timezone: 'UTC' } };
        const $set: Document = { hazard_id: lit(id), ingested_at: { $ifNull: ['$ingested_at', stamp] } };
        for (const [k, v] of Object.entries(rest)) $set[k] = lit(v);
        $set['occurred_at'] = lit(normalizeIso(event.occurred_at));
        if (eventVersion !== undefined) $set['event_version'] = lit(eventVersion);
        if (epoch !== undefined) $set['fence_epoch'] = { $max: [{ $ifNull: ['$fence_epoch', lit(epoch)] }, lit(epoch)] };
        const update: Document[] = [{ $set }];

        try {
            // Fence/version check and write are ONE conditional upsert: if the condition fails on an
            // existing record the upsert tries to insert the same _id and raises E11000 (below).
            // While the store is already known to be degraded a w:2 write can only wait out its whole timeout and then be acknowledged as
            // degraded anyway. Writing at w:1 right away gives the same outcome without the wait (1.5 s per write, which made the drain of
            // a backlog after a node loss take tens of seconds). Strict mode keeps waiting: it must fail closed.
            const quick = !this.o.strictWrites && isStoreDegraded() && this.writeConcern.w !== 1;
            const r = await this.hazards().updateOne(filter, update, { upsert: true, writeConcern: quick ? { w: 1 } : this.writeConcern });
            return { outcome: r.upsertedCount > 0 || r.modifiedCount > 0 ? 'applied' : 'duplicate', hazard_id: id, created: r.upsertedCount > 0, ...(quick ? { degraded: true } : {}) };
        } catch (err) {
            if (isDuplicateKey(err)) return this.classifyRejected(id, epoch, eventVersion);
            if (err instanceof MongoWriteConcernError && !this.o.strictWrites) {
                // wtimeout: the primary applied the write, only the second data member has not confirmed (it is down or
                // re-syncing). Refusing writes for the whole recovery window would stop ingestion; acknowledge it as
                // DEGRADED instead: durable on ONE copy until resync (see docs/consistency.md). Callers count/log `degraded`.
                return { outcome: 'applied', hazard_id: id, created: true, degraded: true, detail: errMsg(err) };
            }
            // Network / server-selection error, or strict mode: the write may or may not have happened.
            return { outcome: 'unavailable', hazard_id: id, detail: errMsg(err) };
        }
    }

    // After a write-concern timeout it is unknown whether this call inserted the record (the stamp comes from the store, so it
    // cannot be compared with anything the caller holds): report created. A duplicate publish is absorbed by consumer dedup; a
    // missed publish would lose a notification.
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
            const quick = !this.o.strictWrites && isStoreDegraded() && this.writeConcern.w !== 1;
            const r = await this.hazards().deleteOne(filter, { writeConcern: quick ? { w: 1 } : this.writeConcern });
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
        // mongos waits for a dead shard until maxTimeMS: when the (cached) probe already knows a unit is down, cut the wait
        // short (healthy shards answer in well under 100ms) so partial answers stay far below the callers' own timeouts.
        const known = await probe;
        const maxTimeMS = known.some((u) => !u.available) ? Math.min(this.deadlineMs, 600) : this.deadlineMs;
        try {
            // Raw `find` instead of a driver cursor: only the server reply says whether mongos dropped a shard's rows
            // (`partialResultsReturned`), e.g. when maxTimeMS expires on a busy shard. The driver hides that flag, and a silently
            // short page with no next_cursor would look like the END of the data.
            const reply = await this.client.db(this.dbName).command({
                find: HAZARDS, filter, sort, limit: q.limit + 1, batchSize: q.limit + 1, singleBatch: true,
                allowPartialResults: true, maxTimeMS,
            }, { readPreference: 'primaryPreferred' });
            const docs = (reply['cursor']?.['firstBatch'] ?? []) as Document[];
            const truncated = reply['cursor']?.['partialResultsReturned'] === true;
            const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
            if (truncated && un.length === 0) {
                // Rows are missing but no unit is known down (slow shard, election): never present this page as complete, and
                // keep the caller at the same position so a retry continues exactly here.
                return { items: [], next_cursor: q.cursor ?? null, partial: true, unavailable_units: ['query-timeout'] };
            }
            const items = docs.slice(0, q.limit).map(toRecord);
            const last = items[items.length - 1];
            return {
                items,
                next_cursor: docs.length > q.limit && last ? encodeCursor({ s: q.sort, k: sortKey(last, q.sort), h: last.hazard_id }) : null,
                partial: truncated || un.length > 0,
                unavailable_units: un,
            };
        } catch (err) {
            if (err instanceof Error && err.message === 'invalid cursor') throw err;
            const un = (await probe).filter((u) => !u.available).map((u) => u.unit);
            return { items: [], next_cursor: q.cursor ?? null, partial: true, unavailable_units: un.length ? un : ['store-router'] };
        }
    }

    // Full scans (analytics, audit checksum). Healthy cluster: through mongos (it also filters orphaned documents during
    // chunk migration). When the cached probe says a unit is unreachable, mongos would wait out the whole scan budget
    // for the dead shard (it has no tunable to give up earlier), so instead read every REACHABLE unit directly, in parallel,
    // de-duplicated by _id (a stale orphan copy can never be counted twice) and report the dead units as unavailable.
    // O(N) in records: fine for the demo dataset; swap for $group pipelines (healthy case) if it grows by orders of magnitude.
    private async scan(filter: Filter<Document>, projection: Document, onDoc: (d: Document) => void): Promise<{ partial: boolean; unavailable: string[] }> {
        const tStart = Date.now();
        const status = await this.unitStatus();
        const tStatus = Date.now() - tStart;
        const down = status.filter((u) => !u.available).map((u) => u.unit);
        const scanMs = this.o.scanDeadlineMs ?? 8000;
        const pageSize = this.o.scanPageSize ?? 5000;
        // maxTimeMS bounds one command, not a whole multi-page scan, so the deadline is enforced HERE and anything that
        // arrives later is discarded: a late callback can never change an answer that was already returned.
        const bounded = async (work: (live: () => boolean) => Promise<void>): Promise<boolean> => {
            let live = true;
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), scanMs); });
            const run = work(() => live).then(() => 'done' as const);
            run.catch(() => undefined);
            try {
                return (await Promise.race([run, timeout])) === 'done';
            } finally {
                live = false;
                clearTimeout(timer);
            }
        };
        if (down.length === 0 || !this.topology) {
            let complete = false;
            let truncated = false;
            try {
                // Keyset pages of single-batch `find`s by _id instead of one driver cursor, for two reasons:
                // 1. only the raw reply carries `partialResultsReturned` (mongos dropped a shard's rows without an error);
                // 2. there is no getMore: the mongos Service load-balances per connection, and a getMore that lands on the
                //    OTHER mongos fails with CursorNotFound.
                complete = await bounded(async (live) => {
                    const db = this.client.db(this.dbName);
                    let after: unknown;
                    for (;;) {
                        const f = (after === undefined ? filter : { $and: [filter, { _id: { $gt: after } }] }) as Filter<Document>;
                        const reply = await db.command({
                            find: HAZARDS, filter: f, projection, sort: { _id: 1 }, limit: pageSize, batchSize: pageSize,
                            singleBatch: true, allowPartialResults: true, maxTimeMS: scanMs,
                        }, { readPreference: 'primaryPreferred' });
                        if (!live()) return;
                        if (reply['cursor']?.['partialResultsReturned'] === true) { truncated = true; return; }
                        const docs = (reply['cursor']?.['firstBatch'] ?? []) as Document[];
                        for (const d of docs) onDoc(d);
                        if (docs.length < pageSize) return;
                        after = docs[docs.length - 1]!['_id'];
                    }
                });
            } catch {
                complete = false;
            }
            if (truncated) complete = false;
            const tScan = Date.now() - tStart;
            const after = (await this.unitStatus()).filter((u) => !u.available).map((u) => u.unit);
            logger.info({ path: 'router', complete, truncated, status_ms: tStatus, scan_ms: tScan, total_ms: Date.now() - tStart }, 'store scan');
            // With allowPartialResults a maxTimeMS expiry can return what was read so far WITHOUT an error: never present that as complete.
            if (!complete) return { partial: true, unavailable: after.length ? after : ['scan-timeout'] };
            return { partial: after.length > 0, unavailable: after };
        }
        const seen = new Set<string>();
        const failedUnits: string[] = [...down];
        await Promise.all(this.topology.units.filter((u) => !down.includes(u.name)).map(async (u) => {
            for (const m of u.members.filter((x) => !x.arbiter)) {
                const docs: Document[] = [];
                try {
                    const ok = await bounded(async (live) => {
                        const cursor = this.memberClient(m, true).db(this.dbName).collection(HAZARDS)
                            .find(filter, { maxTimeMS: scanMs + 2000, readPreference: 'secondaryPreferred', projection });
                        try {
                            for await (const d of cursor) { if (!live()) break; docs.push(d); }
                        } finally {
                            void cursor.close().catch(() => undefined);
                        }
                    });
                    if (!ok) continue;
                } catch { continue; /* try the unit's other data member */ }
                for (const d of docs) { const id = String(d['_id']); if (!seen.has(id)) { seen.add(id); onDoc(d); } }
                return;
            }
            failedUnits.push(u.name);
        }));
        return { partial: true, unavailable: failedUnits };
    }

    async aggregate(q: AnalyticsQuery): Promise<AnalyticsResult> {
        const acc = new AnalyticsAccumulator(q);
        const filter: Filter<Document> = {};
        if (q.from || q.to) filter['occurred_at'] = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
        const r = await this.scan(filter, { hazard_type: 1, severity: 1, area_name: 1, occurred_at: 1, 'attributes.potential_tsunami': 1, 'attributes.tsunami_warning': 1 }, (d) => acc.add(d as never));
        return acc.result(r.partial, r.unavailable);
    }

    async checksum(source?: Source): Promise<ChecksumResult> {
        const refs: string[] = [];
        const r = await this.scan(source ? { source } : {}, { source_ref_id: 1 }, (d) => refs.push(String(d['source_ref_id'])));
        return {
            source: source ?? 'ALL', count: refs.length, checksum: checksumOfRefs(refs), algorithm: 'sha256',
            as_of: new Date().toISOString(), partial: r.partial, unavailable_units: r.unavailable,
        };
    }

    // ---- placement visibility -------------------------------------------------------------------

    private memberClient(m: StoreMember, auth: boolean): MongoClient {
        const key = `${m.host}|${auth}`;
        let c = this.memberClients.get(key);
        if (!c) {
            const cred = auth && this.o.probeUser ? `${encodeURIComponent(this.o.probeUser)}:${encodeURIComponent(this.o.probePassword ?? '')}@` : '';
            const t = auth ? this.deadlineMs : this.probeMs;
            const params = `directConnection=true&heartbeatFrequencyMS=1000&serverSelectionTimeoutMS=${t}&connectTimeoutMS=${t}${auth && cred ? '&authSource=admin' : ''}`;
            c = new MongoClient(`mongodb://${cred}${m.host}:27017/?${params}`);
            this.memberClients.set(key, c);
        }
        return c;
    }

    // A probe client that failed once is discarded: after a member's VM vanished without closing its connections, a long-lived
    // client kept reporting the whole shard as unreachable for minutes although a fresh connection succeeded at once (only an
    // aggregator restart cleared it). The next probe connects from scratch.
    private async hello(m: StoreMember): Promise<{ reachable: boolean; primary: boolean; secondary: boolean }> {
        try {
            // Hard deadline around the probe: a connection to a VM that vanished without closing it can leave the driver call hanging far
            // beyond its own timeouts, and one hanging probe would block the whole status round (and with it the degraded flag).
            let timer: NodeJS.Timeout | undefined;
            const r = await Promise.race([
                this.memberClient(m, false).db('admin').command({ hello: 1 }, { timeoutMS: this.probeMs }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`probe deadline ${this.probeMs + 500} ms`)), this.probeMs + 500); }),
            ]).finally(() => clearTimeout(timer));
            this.noteProbe(m, true);
            return { reachable: true, primary: r['isWritablePrimary'] === true, secondary: r['secondary'] === true };
        } catch (err) {
            this.noteProbe(m, false, errMsg(err));
            const key = `${m.host}|false`;
            const stale = this.memberClients.get(key);
            if (stale) { this.memberClients.delete(key); void stale.close().catch(() => undefined); }
            return { reachable: false, primary: false, secondary: false };
        }
    }

    private readonly probeState = new Map<string, boolean>();
    private noteProbe(m: StoreMember, ok: boolean, error?: string): void {
        if (this.probeState.get(m.name) === ok) return;
        this.probeState.set(m.name, ok);
        logger.warn({ probed_member: m.name, probed_node: m.node, reachable: ok, error }, ok ? 'store member probe recovered' : 'store member probe failed');
    }

    // A unit is available for READS when at least one data-bearing member is a reachable primary or secondary.
    // Served from the background-refreshed cache: never probed on the request path.
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
            const live = hellos.filter((h) => h.primary || h.secondary).length;
            const ok = live > 0;
            return { unit: u.name, available: ok, detail: ok ? undefined : 'no readable data member', redundant: live >= data.length };
        })).then((value) => {
            // Any unit with fewer live data members than configured means two-copy writes cannot be confirmed (see health.ts).
            const short = value.filter((u) => !u.redundant).map((u) => u.unit);
            setStoreDegraded(short.length > 0, short.join(','));
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
