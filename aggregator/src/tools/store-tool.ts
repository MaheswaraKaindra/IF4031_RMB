// P1 measurement tool. Runs INSIDE the aggregator pod (it owns the storage credentials):
//   kubectl -n <ns> exec deploy/aggregator -- node dist/tools/store-tool.js <cmd> [--flag value]
//
//   load   --count N [--seed S] [--days D]   synthetic, geographically skewed catalog (idempotent for the same seed)
//   burst  --region sumatra --count N        write surge concentrated in ONE region, reports per-node write deltas
//   report                                   per-node record counts + write counters, plus checksum per source
//   checksum [--source BMKG]                 count + Appendix A checksum
// Replace `load` with the assistants' real earthquake catalog when it is provided (same ingest path).
import { MongoClient } from 'mongodb';
import { MongoCanonicalRepository } from '../storage/mongoRepository.js';
import { loadTopology } from '../storage/topology.js';
import type { HazardRecord, HazardType, Severity, Source } from '../storage/types.js';

interface Region { name: string; weight: number; lat: number; lon: number; spread: number }
const REGIONS: Record<string, Region> = {
    sumatra: { name: 'Sumatera Barat', weight: 0.40, lat: -1.0, lon: 99.8, spread: 1.5 },
    java: { name: 'Jawa Barat', weight: 0.25, lat: -8.0, lon: 108.0, spread: 1.2 },
    sulawesi: { name: 'Sulawesi Tengah', weight: 0.15, lat: -1.5, lon: 120.5, spread: 1.2 },
    maluku: { name: 'Maluku', weight: 0.10, lat: -4.5, lon: 129.0, spread: 1.5 },
    papua: { name: 'Papua', weight: 0.05, lat: -4.0, lon: 138.5, spread: 1.5 },
    ntt: { name: 'Nusa Tenggara Timur', weight: 0.05, lat: -9.5, lon: 122.5, spread: 1.2 },
};

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(r: () => number): number {
    return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

function pickRegion(r: () => number): Region {
    let x = r();
    for (const reg of Object.values(REGIONS)) {
        if ((x -= reg.weight) <= 0) return reg;
    }
    return REGIONS['sumatra']!;
}

function makeRecord(n: number, seed: number, r: () => number, region: Region, daysBack: number, tag: string): HazardRecord {
    const roll = r();
    const [source, type, sev]: [Source, HazardType, Severity] =
        roll < 0.70 ? ['BMKG', 'SEISMIC', 'WASPADA']
        : roll < 0.85 ? ['PVMBG', 'VOLCANIC', 'NORMAL']
        : roll < 0.95 ? ['SATELIT', 'WILDFIRE', 'WASPADA']
        : ['SENSOR_PANTAI', 'COASTAL', 'SIAGA'];
    const mag = 3 + -Math.log(1 - r()) * 0.8;
    const occurred = Date.now() - Math.floor(r() * daysBack * 86_400_000);
    const severity: Severity = type === 'SEISMIC' ? (mag >= 6.5 ? 'SIAGA' : mag >= 5 ? 'WASPADA' : 'NORMAL') : sev;
    return {
        hazard_id: '', source, source_ref_id: `SYN-${tag}-${seed}-${n}`, hazard_type: type, severity,
        area_name: region.name, latitude: +(region.lat + gauss(r) * region.spread).toFixed(4), longitude: +(region.lon + gauss(r) * region.spread).toFixed(4),
        occurred_at: new Date(occurred).toISOString(), ingested_at: new Date().toISOString(),
        attributes: type === 'SEISMIC' ? { magnitude: +mag.toFixed(1), depth_km: Math.round(5 + r() * 90), potential_tsunami: mag >= 6.5 } : {},
    };
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(Array.from({ length: size }, async () => {
        while (i < items.length) await fn(items[i++]!);
    }));
}

function arg(name: string, dflt?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

async function main(): Promise<void> {
    const cmd = process.argv[2];
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, writeConcern: { w: Number(process.env.STORE_WRITE_W ?? 2), wtimeoutMS: 10000 } });
    await client.connect();
    const repo = new MongoCanonicalRepository({
        client, topology: loadTopology(), probeUser: process.env.STORE_PROBE_USER, probePassword: process.env.STORE_PROBE_PASSWORD,
        writeW: Number(process.env.STORE_WRITE_W ?? 2),
    });
    const out = (o: unknown): void => console.log(JSON.stringify(o));

    try {
        if (cmd === 'load' || cmd === 'burst') {
            const count = Number(arg('count', '10000'));
            const seed = Number(arg('seed', '42'));
            const days = Number(arg('days', '30'));
            const only = cmd === 'burst' ? REGIONS[arg('region', 'sumatra')!] : undefined;
            if (cmd === 'burst' && !only) throw new Error(`unknown region; choose one of ${Object.keys(REGIONS).join(', ')}`);
            const r = rng(seed + (cmd === 'burst' ? Date.now() % 1_000_000 : 0));
            const tag = cmd === 'burst' ? `B${Date.now()}` : 'L';
            const before = await repo.distribution();
            const t0 = performance.now();
            const recs = Array.from({ length: count }, (_, n) => makeRecord(n, seed, r, only ?? pickRegion(r), cmd === 'burst' ? 1 : days, tag));
            const tally: Record<string, number> = {};
            const perRegion: Record<string, number> = {};
            await pool(recs, 32, async (rec) => {
                const res = await repo.ingest({ event: rec });
                tally[res.outcome] = (tally[res.outcome] ?? 0) + 1;
                perRegion[rec.area_name] = (perRegion[rec.area_name] ?? 0) + 1;
            });
            const secs = (performance.now() - t0) / 1000;
            const after = await repo.distribution();
            out({ cmd, count, seconds: +secs.toFixed(2), writes_per_s: Math.round(count / secs), outcomes: tally, input_by_region: perRegion });
            for (const a of after) {
                const b = before.find((x) => x.member === a.member);
                out({ member: a.member, node: a.node, unit: a.unit, role: a.role, count: a.count, insert_delta: a.inserts !== null && b?.inserts != null ? a.inserts - b.inserts : null, update_delta: a.updates !== null && b?.updates != null ? a.updates - b.updates : null });
            }
        } else if (cmd === 'report') {
            const rows = await repo.distribution();
            const total = (await repo.checksum()).count;
            const perNode: Record<string, number> = {};
            for (const x of rows) perNode[x.node] = (perNode[x.node] ?? 0) + (x.count ?? 0);
            out({ logical_records: total, per_node_copies: perNode, max_node_share: total ? +(Math.max(0, ...Object.values(perNode)) / total).toFixed(3) : null });
            rows.forEach((x) => out(x));
            for (const s of ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'] as Source[]) out(await repo.checksum(s));
        } else if (cmd === 'checksum') {
            out(await repo.checksum(arg('source') as Source | undefined));
        } else {
            throw new Error('usage: store-tool <load|burst|report|checksum> [--count N] [--seed S] [--days D] [--region R] [--source S]');
        }
    } finally {
        await repo.close();
        await client.close();
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
