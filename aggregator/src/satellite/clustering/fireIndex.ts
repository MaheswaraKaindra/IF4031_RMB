import type { Detection } from './detection.js';
import { buildFire, type FireDelta } from './fire.js';
import type { Fire } from './fire.js';
import { haversineKm, KM_PER_DEG_LAT } from './geo.js';

export const MAX_DISTANCE_KM = 1.0;
export const MAX_GAP_MS = 360 * 60_000;

const CELL_DEG = 0.01;

/**
 * Connected components of the detection graph, recomputed on the part of the graph a change can touch.
 * Fire identity is a pure function of the member set (earliest detection), so a replay or a different
 * arrival order yields the same fires. Edge removal is handled by recomputation, not by union-find.
 */
export class FireIndex {
    private readonly detections = new Map<string, Detection>();
    private readonly grid = new Map<string, Set<string>>();
    private readonly fireOf = new Map<string, string>();
    private readonly fireStore = new Map<string, Fire>();
    private readonly low = new Map<string, Detection>();
    private filteredLow = 0;

    get size(): number {
        return this.detections.size;
    }

    get filteredLowCount(): number {
        return this.filteredLow;
    }

    get singletonCount(): number {
        return this.detections.size - this.fireOf.size;
    }

    fires(): Fire[] {
        return [...this.fireStore.values()].sort((a, b) => (a.fire_id < b.fire_id ? -1 : a.fire_id > b.fire_id ? 1 : 0));
    }

    getFire(id: string): Fire | undefined {
        return this.fireStore.get(id);
    }

    find(key: string): Detection | undefined {
        return this.detections.get(key) ?? this.low.get(key);
    }

    get lowCount(): number {
        return this.low.size;
    }

    upsert(d: Detection): FireDelta {
        if (d.confidence === 'l') {
            const delta = this.detections.has(d.key) ? this.removeFromGraph(d.key) : { upserts: [], removed: [] };
            if (!this.low.has(d.key)) this.filteredLow += 1;
            this.low.set(d.key, d);
            return delta;
        }
        this.low.delete(d.key);
        const existing = this.detections.get(d.key);
        if (existing && sameDetection(existing, d)) return { upserts: [], removed: [] };

        const seeds = new Set<string>([d.key]);
        if (existing) this.collectTouched(existing, seeds);
        this.detections.set(d.key, d);
        if (existing) this.gridRemove(existing);
        this.gridAdd(d);
        this.collectTouched(d, seeds);
        return this.recompute(seeds);
    }

    /** Everything needed to rebuild this index: the detections it holds (kept and low confidence). Fires are derived, not stored. */
    exportState(): { kept: Detection[]; low: Detection[]; filteredLow: number } {
        return { kept: [...this.detections.values()], low: [...this.low.values()], filteredLow: this.filteredLow };
    }

    /** Rebuilds an empty index from exportState(): fire identity is a function of the member set, so the same detections give the same fires. */
    restoreState(state: { kept: Detection[]; low: Detection[]; filteredLow: number }): void {
        if (this.detections.size > 0 || this.low.size > 0) throw new Error('restoreState needs an empty index');
        for (const d of [...state.kept].sort((a, b) => a.time_ms - b.time_ms || (a.key < b.key ? -1 : 1))) this.upsert(d);
        for (const d of state.low) this.low.set(d.key, d);
        this.filteredLow = state.filteredLow;
    }

    retract(key: string): FireDelta {
        this.low.delete(key);
        return this.removeFromGraph(key);
    }

    /** Drops finalized state: components whose newest detection is older than cutoffMs can no longer be reached by an admissible detection. */
    evictFinalized(cutoffMs: number): { fires: number; detections: number } {
        let fires = 0;
        let detections = 0;
        for (const fire of [...this.fireStore.values()]) {
            const members = fire.detection_keys.map((k) => this.detections.get(k)!);
            if (Math.max(...members.map((m) => m.time_ms)) >= cutoffMs) continue;
            for (const m of members) {
                this.gridRemove(m);
                this.detections.delete(m.key);
                this.fireOf.delete(m.key);
                detections += 1;
            }
            this.fireStore.delete(fire.fire_id);
            fires += 1;
        }
        for (const d of [...this.detections.values()]) {
            if (this.fireOf.has(d.key) || d.time_ms >= cutoffMs) continue;
            this.gridRemove(d);
            this.detections.delete(d.key);
            detections += 1;
        }
        for (const [k, d] of this.low) if (d.time_ms < cutoffMs) this.low.delete(k);
        return { fires, detections };
    }

    private removeFromGraph(key: string): FireDelta {
        const existing = this.detections.get(key);
        if (!existing) return { upserts: [], removed: [] };
        const seeds = new Set<string>();
        this.collectTouched(existing, seeds);
        seeds.delete(key);
        this.gridRemove(existing);
        this.detections.delete(key);
        const oldFire = this.fireOf.get(key);
        this.fireOf.delete(key);
        if (oldFire) for (const k of this.membersOf(oldFire)) seeds.add(k);
        seeds.delete(key);
        return this.recompute(seeds, oldFire ? [oldFire] : []);
    }

    private collectTouched(d: Detection, seeds: Set<string>): void {
        for (const n of this.neighbours(d)) {
            seeds.add(n.key);
            const f = this.fireOf.get(n.key);
            if (f) for (const k of this.membersOf(f)) seeds.add(k);
        }
        const own = this.fireOf.get(d.key);
        if (own) for (const k of this.membersOf(own)) seeds.add(k);
    }

    private membersOf(fireId: string): string[] {
        return this.fireStore.get(fireId)?.detection_keys ?? [];
    }

    private recompute(seeds: Set<string>, extraOld: string[] = []): FireDelta {
        const oldIds = new Set<string>(extraOld);
        for (const k of seeds) {
            const f = this.fireOf.get(k);
            if (f) oldIds.add(f);
        }
        for (const k of seeds) this.fireOf.delete(k);

        const visited = new Set<string>();
        const fresh: Fire[] = [];
        for (const start of [...seeds].sort()) {
            const root = this.detections.get(start);
            if (!root || visited.has(start)) continue;
            const members: Detection[] = [];
            const queue = [root];
            visited.add(start);
            while (queue.length > 0) {
                const cur = queue.pop()!;
                members.push(cur);
                for (const n of this.neighbours(cur)) {
                    if (visited.has(n.key)) continue;
                    visited.add(n.key);
                    queue.push(n);
                }
            }
            if (members.length >= 2) fresh.push(buildFire(members));
        }

        const newIds = new Set(fresh.map((f) => f.fire_id));
        const removed = [...oldIds].filter((id) => !newIds.has(id)).sort();
        for (const id of removed) this.fireStore.delete(id);
        const upserts: Fire[] = [];
        for (const f of fresh) {
            for (const k of f.detection_keys) this.fireOf.set(k, f.fire_id);
            const prev = this.fireStore.get(f.fire_id);
            this.fireStore.set(f.fire_id, f);
            if (!prev || JSON.stringify(prev) !== JSON.stringify(f)) upserts.push(f);
        }
        upserts.sort((a, b) => (a.fire_id < b.fire_id ? -1 : 1));
        return { upserts, removed };
    }

    private neighbours(d: Detection): Detection[] {
        const lonDeg = MAX_DISTANCE_KM / (KM_PER_DEG_LAT * Math.cos((Math.min(89, Math.abs(d.latitude) + CELL_DEG) * Math.PI) / 180));
        const latCells = Math.ceil(MAX_DISTANCE_KM / KM_PER_DEG_LAT / CELL_DEG);
        const lonCells = Math.ceil(lonDeg / CELL_DEG);
        const cy = Math.floor(d.latitude / CELL_DEG);
        const cx = Math.floor(d.longitude / CELL_DEG);
        const out: Detection[] = [];
        for (let y = cy - latCells; y <= cy + latCells; y++) {
            for (let x = cx - lonCells; x <= cx + lonCells; x++) {
                const bucket = this.grid.get(`${y}:${x}`);
                if (!bucket) continue;
                for (const k of bucket) {
                    if (k === d.key) continue;
                    const o = this.detections.get(k)!;
                    if (Math.abs(o.time_ms - d.time_ms) > MAX_GAP_MS) continue;
                    if (haversineKm(d.latitude, d.longitude, o.latitude, o.longitude) > MAX_DISTANCE_KM) continue;
                    out.push(o);
                }
            }
        }
        return out;
    }

    private cellKey(d: Detection): string {
        return `${Math.floor(d.latitude / CELL_DEG)}:${Math.floor(d.longitude / CELL_DEG)}`;
    }

    private gridAdd(d: Detection): void {
        const ck = this.cellKey(d);
        let bucket = this.grid.get(ck);
        if (!bucket) this.grid.set(ck, (bucket = new Set()));
        bucket.add(d.key);
    }

    private gridRemove(d: Detection): void {
        const ck = this.cellKey(d);
        const bucket = this.grid.get(ck);
        bucket?.delete(d.key);
        if (bucket && bucket.size === 0) this.grid.delete(ck);
    }
}

function sameDetection(a: Detection, b: Detection): boolean {
    return (
        a.time_ms === b.time_ms &&
        a.latitude === b.latitude &&
        a.longitude === b.longitude &&
        a.confidence === b.confidence &&
        a.frp_mw === b.frp_mw &&
        a.satellite === b.satellite
    );
}
