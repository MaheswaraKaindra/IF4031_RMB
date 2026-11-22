import { parseAcquisitionTime } from '../clustering/detection.js';
import type { FireDelta } from '../clustering/fire.js';
import { FireIndex, MAX_GAP_MS } from '../clustering/fireIndex.js';
import { decodeFrame } from '../feed/frames.js';

export interface ProcessorConfig {
    lateness_ms: number;
    evict_every_offsets: number;
}

export interface LateDetection {
    key: string;
    offset: number;
    time_ms: number;
    watermark_ms: number;
    behind_ms: number;
}

export interface ProcessorSnapshot {
    cfg: ProcessorConfig;
    watermarkMs: number | null;
    retracted: Array<[string, number]>;
    counters: ProcessorCounters;
    index: { kept: import('../clustering/detection.js').Detection[]; low: import('../clustering/detection.js').Detection[]; filteredLow: number };
}

export interface FrameResult {
    delta: FireDelta;
    late?: LateDetection;
}

export interface ProcessorCounters {
    detections: number;
    updates: number;
    retracts: number;
    heartbeats: number;
    invalid: number;
    lateDetections: number;
    ignoredRetracted: number;
    unknownCorrections: number;
}

const NONE: FireDelta = { upserts: [], removed: [] };

/**
 * Deterministic function of the frame sequence: the same log prefix always yields the same index, watermark and counters,
 * which is what makes crash recovery by replay produce the same fires as an uninterrupted run.
 * Event time only: the watermark is the newest detection time or feed heartbeat time, never the machine clock.
 */
export class SatelliteProcessor {
    readonly index = new FireIndex();
    readonly counters: ProcessorCounters = {
        detections: 0,
        updates: 0,
        retracts: 0,
        heartbeats: 0,
        invalid: 0,
        lateDetections: 0,
        ignoredRetracted: 0,
        unknownCorrections: 0,
    };
    watermarkMs = Number.NEGATIVE_INFINITY;
    private readonly retracted = new Map<string, number>();

    constructor(private readonly cfg: ProcessorConfig) {}

    /** Complete state after the frames applied so far, small enough to store: the live detections, the retraction memory and the watermark. */
    exportState(): ProcessorSnapshot {
        return {
            cfg: { lateness_ms: this.cfg.lateness_ms, evict_every_offsets: this.cfg.evict_every_offsets },
            watermarkMs: Number.isFinite(this.watermarkMs) ? this.watermarkMs : null,
            retracted: [...this.retracted.entries()],
            counters: { ...this.counters },
            index: this.index.exportState(),
        };
    }

    /** Only into a fresh processor, and only for the same configuration: a snapshot taken under other settings is not the same state. */
    importState(s: ProcessorSnapshot): void {
        if (s.cfg.lateness_ms !== this.cfg.lateness_ms || s.cfg.evict_every_offsets !== this.cfg.evict_every_offsets) throw new Error('snapshot was taken under a different configuration');
        this.index.restoreState(s.index);
        this.watermarkMs = s.watermarkMs ?? Number.NEGATIVE_INFINITY;
        this.retracted.clear();
        for (const [k, t] of s.retracted) this.retracted.set(k, t);
        Object.assign(this.counters, s.counters);
    }

    get retractedCount(): number {
        return this.retracted.size;
    }

    apply(offset: number, kind: string, raw: string): FrameResult {
        const result = this.handle(offset, kind, raw);
        if (this.cfg.evict_every_offsets > 0 && offset % this.cfg.evict_every_offsets === 0) this.evict();
        return result;
    }

    private handle(offset: number, kind: string, raw: string): FrameResult {
        const ev = decodeFrame({ id: String(offset), event: kind, data: raw });
        switch (ev.kind) {
            case 'heartbeat':
                this.counters.heartbeats += 1;
                if (ev.virtualNowMs !== undefined && ev.virtualNowMs > this.watermarkMs) this.watermarkMs = ev.virtualNowMs;
                return { delta: NONE };
            case 'invalid':
                this.counters.invalid += 1;
                return { delta: NONE };
            case 'detection': {
                const d = ev.detection;
                this.counters.detections += 1;
                if (this.retracted.has(d.key)) {
                    this.counters.ignoredRetracted += 1;
                    return { delta: NONE };
                }
                if (d.time_ms < this.watermarkMs - this.cfg.lateness_ms) {
                    this.counters.lateDetections += 1;
                    return {
                        delta: NONE,
                        late: { key: d.key, offset, time_ms: d.time_ms, watermark_ms: this.watermarkMs, behind_ms: this.watermarkMs - d.time_ms },
                    };
                }
                if (d.time_ms > this.watermarkMs) this.watermarkMs = d.time_ms;
                return { delta: this.index.upsert(d) };
            }
            case 'update': {
                this.counters.updates += 1;
                const target = this.index.find(ev.key);
                if (!target) {
                    this.counters.unknownCorrections += 1;
                    return { delta: NONE };
                }
                return { delta: this.index.upsert({ ...target, ...ev.changes }) };
            }
            case 'retract': {
                this.counters.retracts += 1;
                const target = this.index.find(ev.key);
                this.retracted.set(ev.key, target?.time_ms ?? timeFromKey(ev.key) ?? this.watermarkMs);
                if (!target) {
                    this.counters.unknownCorrections += 1;
                    return { delta: NONE };
                }
                return { delta: this.index.retract(ev.key) };
            }
        }
    }

    private evict(): void {
        if (!Number.isFinite(this.watermarkMs)) return;
        const cutoff = this.watermarkMs - this.cfg.lateness_ms - MAX_GAP_MS;
        this.index.evictFinalized(cutoff);
        for (const [k, t] of this.retracted) if (t < cutoff) this.retracted.delete(k);
    }
}

function timeFromKey(key: string): number | undefined {
    const parts = key.split('|');
    if (parts.length < 3) return undefined;
    try {
        return parseAcquisitionTime(parts[1]!, parts[2]!);
    } catch {
        return undefined;
    }
}
