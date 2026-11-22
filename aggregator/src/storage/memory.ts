import { AnalyticsAccumulator } from './analytics.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { hazardIdFor } from './identity.js';
import { checksumOfRefs, compareRecords, isAfterCursor, kWayMerge, sortKey } from './merge.js';
import type {
    AnalyticsQuery, AnalyticsResult, ChecksumResult, GlobalQuery, HazardRecord, ICanonicalRepository,
    IngestInput, IngestResult, LocateResult, Page, RecordFilter, Source, UnitStatus,
} from './types.js';

interface Stored {
    rec: HazardRecord;
    version: number | undefined;
    epoch: number | undefined;
}

// Reference implementation + test double. It does REAL scatter-gather (per-unit sorted lists merged with
// kWayMerge) so Owners B/C exercise the same ordering, cursor and partial semantics as production.
export class InMemoryRepository implements ICanonicalRepository {
    private readonly units: Map<string, Stored>[];
    private readonly down = new Set<number>();

    constructor(private readonly unitCount = 3, private readonly nodes: string[] = ['node-1', 'node-2', 'node-3']) {
        this.units = Array.from({ length: unitCount }, () => new Map());
    }

    setUnitDown(i: number, isDown: boolean): void {
        if (isDown) this.down.add(i);
        else this.down.delete(i);
    }

    private unitOf(id: string): number {
        let h = 0;
        for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return h % this.unitCount;
    }

    private unitName(i: number): string {
        return `shard-${i + 1}`;
    }

    private unavailable(): string[] {
        return [...this.down].map((i) => this.unitName(i));
    }

    async ingest({ event, eventVersion, epoch }: IngestInput): Promise<IngestResult> {
        const id = hazardIdFor(event.source, event.source_ref_id);
        const u = this.unitOf(id);
        if (this.down.has(u)) return { outcome: 'unavailable', hazard_id: id, detail: `${this.unitName(u)} unreachable` };
        const store = this.units[u]!;
        const existing = store.get(id);
        if (existing) {
            if (epoch !== undefined && existing.epoch !== undefined && existing.epoch > epoch) return { outcome: 'stale_epoch', hazard_id: id };
            if (eventVersion !== undefined && existing.version !== undefined && existing.version > eventVersion) return { outcome: 'stale_version', hazard_id: id };
            if (eventVersion !== undefined && existing.version === eventVersion) return { outcome: 'duplicate', hazard_id: id };
        }
        const rec: HazardRecord = { ...event, hazard_id: id, ingested_at: existing?.rec.ingested_at ?? event.ingested_at };
        const same = existing && JSON.stringify(existing.rec) === JSON.stringify(rec);
        store.set(id, {
            rec,
            version: eventVersion ?? existing?.version,
            epoch: epoch !== undefined ? Math.max(epoch, existing?.epoch ?? epoch) : existing?.epoch,
        });
        return { outcome: same ? 'duplicate' : 'applied', hazard_id: id, created: !existing };
    }

    async getById(id: string): Promise<HazardRecord | null> {
        const u = this.unitOf(id);
        if (this.down.has(u)) return null;
        return this.units[u]!.get(id)?.rec ?? null;
    }

    async remove(id: string, epoch?: number): Promise<IngestResult> {
        const u = this.unitOf(id);
        if (this.down.has(u)) return { outcome: 'unavailable', hazard_id: id };
        const existing = this.units[u]!.get(id);
        if (existing && epoch !== undefined && existing.epoch !== undefined && existing.epoch > epoch) {
            return { outcome: 'stale_epoch', hazard_id: id };
        }
        this.units[u]!.delete(id);
        return { outcome: existing ? 'applied' : 'duplicate', hazard_id: id };
    }

    private matches(r: HazardRecord, f: RecordFilter | undefined, sort: GlobalQuery['sort']): boolean {
        if (!f) return true;
        if (f.source && r.source !== f.source) return false;
        if (f.hazard_type && r.hazard_type !== f.hazard_type) return false;
        if (f.severity && r.severity !== f.severity) return false;
        if (f.since && sortKey(r, sort) < f.since) return false;
        return true;
    }

    async queryGlobal(q: GlobalQuery): Promise<Page<HazardRecord>> {
        const cur = q.cursor ? decodeCursor(q.cursor, q.sort) : undefined;
        const lists: HazardRecord[][] = [];
        this.units.forEach((store, i) => {
            if (this.down.has(i)) return;
            const rows = [...store.values()]
                .map((s) => s.rec)
                .filter((r) => this.matches(r, q.filter, q.sort))
                .filter((r) => !cur || isAfterCursor(r, q.sort, cur.k, cur.h))
                .sort((a, b) => compareRecords(a, b, q.sort))
                .slice(0, q.limit + 1);
            lists.push(rows);
        });
        const merged = kWayMerge(lists, q.sort, q.limit + 1);
        const items = merged.slice(0, q.limit);
        const last = items[items.length - 1];
        const hasMore = merged.length > q.limit;
        const un = this.unavailable();
        return {
            items,
            next_cursor: hasMore && last ? encodeCursor({ s: q.sort, k: sortKey(last, q.sort), h: last.hazard_id }) : null,
            partial: un.length > 0,
            unavailable_units: un,
        };
    }

    async aggregate(q: AnalyticsQuery): Promise<AnalyticsResult> {
        const acc = new AnalyticsAccumulator(q);
        this.units.forEach((store, i) => {
            if (!this.down.has(i)) for (const s of store.values()) acc.add(s.rec);
        });
        const un = this.unavailable();
        return acc.result(un.length > 0, un);
    }

    async checksum(source?: Source): Promise<ChecksumResult> {
        const refs: string[] = [];
        this.units.forEach((store, i) => {
            if (this.down.has(i)) return;
            for (const s of store.values()) if (!source || s.rec.source === source) refs.push(s.rec.source_ref_id);
        });
        const un = this.unavailable();
        return {
            source: source ?? 'ALL', count: refs.length, checksum: checksumOfRefs(refs), algorithm: 'sha256',
            as_of: new Date().toISOString(), partial: un.length > 0, unavailable_units: un,
        };
    }

    async locate(id: string): Promise<LocateResult | null> {
        const u = this.unitOf(id);
        if (this.down.has(u)) return { hazard_id: id, locations: [], partial: true };
        if (!this.units[u]!.has(id)) return null;
        return {
            hazard_id: id,
            partial: false,
            locations: [
                { node: this.nodes[u % this.nodes.length]!, unit: this.unitName(u), role: 'primary' },
                { node: this.nodes[(u + 1) % this.nodes.length]!, unit: `${this.unitName(u)}-r1`, role: 'replica' },
            ],
        };
    }

    async unitStatus(): Promise<UnitStatus[]> {
        return this.units.map((_, i) => ({ unit: this.unitName(i), available: !this.down.has(i) }));
    }
}
