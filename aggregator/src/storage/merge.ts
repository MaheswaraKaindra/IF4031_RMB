import { createHash } from 'node:crypto';
import type { HazardRecord, SortOrder } from './types.js';

export function sortKey(r: HazardRecord, sort: SortOrder): string {
    return sort === 'occurred_desc' ? r.occurred_at : r.ingested_at;
}

// Total order used everywhere (fake, Mongo sort, cursor): primary key, then hazard_id ascending.
// occurred_desc: newest first. ingested_asc: oldest first.
export function compareRecords(a: HazardRecord, b: HazardRecord, sort: SortOrder): number {
    const ka = sortKey(a, sort);
    const kb = sortKey(b, sort);
    if (ka !== kb) {
        const asc = ka < kb ? -1 : 1;
        return sort === 'occurred_desc' ? -asc : asc;
    }
    return a.hazard_id < b.hazard_id ? -1 : a.hazard_id > b.hazard_id ? 1 : 0;
}

// True when `r` comes strictly after the cursor position in the sort order.
export function isAfterCursor(r: HazardRecord, sort: SortOrder, k: string, h: string): boolean {
    const probe = { hazard_id: h, occurred_at: k, ingested_at: k } as HazardRecord;
    return compareRecords(r, probe, sort) > 0;
}

// k-way merge of already sorted lists (one per storage unit). Replicas must never be passed as extra
// lists: they would duplicate records.
export function kWayMerge(lists: HazardRecord[][], sort: SortOrder, limit: number): HazardRecord[] {
    const heads = lists.map(() => 0);
    const out: HazardRecord[] = [];
    while (out.length < limit) {
        let best = -1;
        for (let i = 0; i < lists.length; i++) {
            const list = lists[i]!;
            const head = heads[i]!;
            if (head >= list.length) continue;
            if (best === -1 || compareRecords(list[head]!, lists[best]![heads[best]!]!, sort) < 0) best = i;
        }
        if (best === -1) break;
        out.push(lists[best]![heads[best]!]!);
        heads[best]!++;
    }
    return out;
}

// Appendix A: SHA-256 over source_ref_id values sorted ascending by BYTE order, joined by \n, no trailing newline.
export function checksumOfRefs(refs: string[]): string {
    const sorted = refs.map((r) => Buffer.from(r, 'utf8')).sort(Buffer.compare);
    const h = createHash('sha256');
    sorted.forEach((buf, i) => {
        if (i > 0) h.update('\n');
        h.update(buf);
    });
    return h.digest('hex');
}
