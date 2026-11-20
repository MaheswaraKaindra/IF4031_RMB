import pino from 'pino';
import { InMemoryCheckpointStore } from '../../coordination/checkpoints.js';
import { InMemorySourceFenceStore } from '../../coordination/fencing.js';
import type { LeaderLeaseHandle } from '../../coordination/leaderLoop.js';
import { InMemoryRepository } from '../../storage/memory.js';
import { InMemoryFeedLog, type FeedLogEntry } from '../feed/log.js';
import { InMemoryLateStore } from './lateStore.js';
import { SatelliteProcessor } from './processor.js';
import { runSatelliteProcessing, SATELLITE_PARTITION, SATELLITE_SOURCE, type RunnerDeps } from './runner.js';

export const silent = pino({ level: 'silent' });

export const CFG = { lateness_ms: 360 * 60_000, evict_every_offsets: 50 };

export const DAY0 = Date.parse('2026-12-07T00:00:00Z');

export const KM_LAT = 1 / 111.19;

export interface FrameSpec {
    kind: 'detection' | 'update' | 'retract' | 'heartbeat';
    make: (offset: number) => string;
}

export interface Det {
    sat: string;
    min: number;
    lat: number;
    lon: number;
    conf: 'l' | 'n' | 'h';
    frp: number;
}

export function acq(min: number): { date: string; time: number } {
    const d = new Date(DAY0 + min * 60_000);
    return { date: d.toISOString().slice(0, 10), time: d.getUTCHours() * 100 + d.getUTCMinutes() };
}

export function keyOf(d: Det): string {
    const a = acq(d.min);
    return `${d.sat}|${a.date}|${a.time}|${JSON.stringify(d.lat)}|${JSON.stringify(d.lon)}`;
}

export function detFrame(d: Det): FrameSpec {
    const a = acq(d.min);
    return {
        kind: 'detection',
        make: (offset) =>
            JSON.stringify({ offset, detection: { acq_date: a.date, acq_time: a.time, confidence: d.conf, frp: d.frp, instrument: 'VIIRS', latitude: d.lat, longitude: d.lon, satellite: d.sat } }),
    };
}

export function updFrame(d: Det, changes: Record<string, unknown>): FrameSpec {
    return { kind: 'update', make: (offset) => JSON.stringify({ offset, key: keyOf(d), changes }) };
}

export function retFrame(d: Det): FrameSpec {
    return { kind: 'retract', make: (offset) => JSON.stringify({ offset, reason: 'false_positive', key: keyOf(d) }) };
}

export function hbFrame(min: number): FrameSpec {
    return { kind: 'heartbeat', make: (offset) => JSON.stringify({ offset, virtual_now: new Date(DAY0 + min * 60_000).toISOString() }) };
}

export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function round5(v: number): number {
    return Math.round(v * 1e5) / 1e5;
}

/** A synthetic feed with chains, two satellites, out-of-order arrival, duplicates, low confidence, updates, retracts, heartbeats and late detections. */

export function genStream(seed: number): FrameSpec[] {
    const r = rng(seed);
    const sats = ['N', 'N20', 'N21'];
    const dets: Det[] = [];
    const retractions: Det[] = [];
    for (let c = 0; c < 8; c++) {
        const lat0 = round5(-7 + r() * 10);
        const lon0 = round5(96 + r() * 36);
        const len = 3 + Math.floor(r() * 7);
        const t0 = Math.floor(r() * 600);
        const chain: Det[] = [];
        for (let i = 0; i < len; i++) {
            chain.push({
                sat: sats[Math.floor(r() * 3)]!,
                min: t0 + i * 40 + Math.floor(r() * 15),
                lat: round5(lat0 + i * 0.0065 * (0.6 + r() * 0.4)),
                lon: round5(lon0 + r() * 0.002),
                conf: r() < 0.15 ? 'l' : r() < 0.5 ? 'h' : 'n',
                frp: Math.round(r() * 90) / 10,
            });
        }
        dets.push(...chain);
        if (c % 3 === 0 && chain.length > 4) retractions.push(chain[2]!);
        if (c === 5) retractions.push(...chain);
    }
    for (let i = 0; i < 5; i++) {
        dets.push({ sat: 'N20', min: Math.floor(r() * 700), lat: round5(-9 + r() * 14), lon: round5(95 + r() * 40), conf: 'n', frp: 1.5 });
    }
    for (let i = 0; i < dets.length - 1; i++) {
        const j = i + Math.floor(r() * 12);
        if (j < dets.length) [dets[i], dets[j]] = [dets[j]!, dets[i]!];
    }

    const out: FrameSpec[] = [];
    const due: Array<{ at: number; spec: FrameSpec }> = [];
    let maxMin = 0;
    const lateAt = Math.floor(dets.length * 0.7);
    dets.forEach((d, idx) => {
        out.push(detFrame(d));
        maxMin = Math.max(maxMin, d.min);
        if (r() < 0.1) due.push({ at: out.length + 1 + Math.floor(r() * 10), spec: detFrame(d) });
        if (r() < 0.2) due.push({ at: out.length + 1 + Math.floor(r() * 15), spec: updFrame(d, { frp: Math.round(r() * 400) / 10, confidence: r() < 0.5 ? 'h' : 'n' }) });
        if (retractions.includes(d)) due.push({ at: out.length + 5 + Math.floor(r() * 10), spec: retFrame(d) });
        if (idx % 6 === 5) out.push(hbFrame(maxMin + 1));
        if (idx === lateAt) {
            for (let k = 0; k < 3; k++) out.push(detFrame({ sat: 'N', min: -2000 - k, lat: round5(1 + k * 0.001), lon: 100, conf: 'n', frp: 2 }));
        }
        for (const x of due.filter((q) => q.at <= out.length)) out.push(x.spec);
        for (let i = due.length - 1; i >= 0; i--) if (due[i]!.at <= out.length) due.splice(i, 1);
    });
    for (const x of due) out.push(x.spec);
    out.push(hbFrame(maxMin + 5));
    return out;
}

export function toEntries(frames: FrameSpec[], from = 0): FeedLogEntry[] {
    return frames.map((f, i) => ({ offset: from + i, kind: f.kind, raw: f.make(from + i), received_at: new Date(1_700_000_000_000 + i).toISOString() }));
}

export function noopMetrics(): RunnerDeps['metrics'] {
    return { inc() {}, set() {}, observe() {} };
}

export interface Rig {
    log: InMemoryFeedLog;
    repo: InMemoryRepository;
    cps: InMemoryCheckpointStore;
    fence: InMemorySourceFenceStore;
    late: InMemoryLateStore;
}

export function newRig(): Rig {
    return { log: new InMemoryFeedLog(), repo: new InMemoryRepository(3), cps: new InMemoryCheckpointStore(), fence: new InMemorySourceFenceStore(), late: new InMemoryLateStore() };
}

export async function newHandle(fence: InMemorySourceFenceStore): Promise<{ handle: LeaderLeaseHandle; ac: AbortController }> {
    const epoch = await fence.activateEpoch(SATELLITE_SOURCE, 'pod');
    const ac = new AbortController();
    return { handle: { epoch, signal: ac.signal, isStillValid: () => !ac.signal.aborted }, ac };
}

export function deps(rig: Rig, over: Partial<RunnerDeps> = {}): RunnerDeps {
    return {
        log: rig.log,
        checkpoints: rig.cps,
        repo: rig.repo,
        fenceStore: rig.fence,
        lateStore: rig.late,
        cfg: CFG,
        metrics: noopMetrics(),
        logger: silent,
        batchSize: 7,
        pollMs: 2,
        retryMs: 2,
        ...over,
    };
}

export async function committedOffset(rig: Rig): Promise<number> {
    const cp = await rig.cps.get(SATELLITE_SOURCE, SATELLITE_PARTITION);
    return cp ? Number(cp.committed_offset) : -1;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('condition not met in time');
}

/** Runs a leader until everything in the log is committed, then stops it. */

export async function runToCatchUp(rig: Rig, over: Partial<RunnerDeps> = {}): Promise<void> {
    const { handle, ac } = await newHandle(rig.fence);
    const run = runSatelliteProcessing(deps(rig, over), handle);
    await waitFor(async () => (await committedOffset(rig)) === (await rig.log.tail()));
    ac.abort();
    await run;
}

export async function canonical(repo: InMemoryRepository): Promise<unknown[]> {
    const page = await repo.queryGlobal({ sort: 'ingested_asc', limit: 5000 });
    return page.items
        .map((r) => ({ ...r, ingested_at: undefined }))
        .sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
}

export async function reference(frames: FrameSpec[]): Promise<{ fires: unknown[]; late: string[] }> {
    const rig = newRig();
    await rig.log.append(toEntries(frames));
    await runToCatchUp(rig, { batchSize: 10_000 });
    return { fires: await canonical(rig.repo), late: [...rig.late.records.keys()].sort() };
}
