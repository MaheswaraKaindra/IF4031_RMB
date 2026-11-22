import { nearestProvince } from '../satellite/clustering/provinces.js';
import { mapSeismicToHazard } from '../utils/mapper.js';
import type { HazardRecord } from '../storage/types.js';

/**
 * Earthquake catalog for P1: a generator that imitates how real seismicity is distributed (so the skew tests do not run on uniform
 * random points) and a parser/loader for a catalog file. Every row goes through mapSeismicToHazard, the SAME mapping the BMKG ingest
 * uses, and through the repository's normal ingest, so the stored records are indistinguishable from fetched ones.
 * The assistants' real catalog is loaded with the same code once its format is known: the parser accepts JSON lines and CSV and the usual
 * column names (id/event_id, time/origin_time, latitude/lat, longitude/lon, magnitude/mag, depth/depth_km, place/region).
 */
export interface CatalogRow {
    event_id: string;
    magnitude: number;
    depth_km: number;
    epicenter_lat: number;
    epicenter_lon: number;
    region_name: string;
    occurred_at: string;
    potential_tsunami: boolean;
}

interface Zone {
    name: string;
    weight: number; // share of mainshock sequences
    path: Array<[number, number]>; // [lat, lon] polyline along the fault arc
    depth: [number, number];
    shallow: number; // share of events in the shallow crust
}

// Hot zones along the subduction arcs and the big strike-slip systems: most of the catalog sits in a few of them, which is the skew P1 must survive.
export const ZONES: Zone[] = [
    { name: 'Sumatra subduction', weight: 0.28, path: [[5.5, 94.8], [2.0, 97.0], [-2.0, 99.5], [-5.5, 102.2]], depth: [10, 70], shallow: 0.7 },
    { name: 'Java trench', weight: 0.16, path: [[-8.2, 104.5], [-9.6, 108.5], [-10.2, 113.5], [-10.6, 117.0]], depth: [10, 120], shallow: 0.5 },
    { name: 'Nusa Tenggara', weight: 0.10, path: [[-9.5, 117.5], [-10.0, 121.0], [-9.2, 125.0]], depth: [10, 150], shallow: 0.5 },
    { name: 'Banda arc', weight: 0.14, path: [[-6.0, 126.0], [-5.0, 129.0], [-3.8, 131.5]], depth: [10, 600], shallow: 0.35 },
    { name: 'Sulawesi', weight: 0.12, path: [[1.4, 120.5], [-0.9, 119.9], [-3.5, 121.2]], depth: [5, 80], shallow: 0.8 },
    { name: 'Halmahera and Talaud', weight: 0.08, path: [[3.8, 126.7], [1.5, 127.6], [0.0, 128.2]], depth: [10, 200], shallow: 0.5 },
    { name: 'Papua', weight: 0.08, path: [[-2.7, 135.5], [-3.6, 138.0], [-4.2, 141.0]], depth: [5, 60], shallow: 0.85 },
    { name: 'Background', weight: 0.04, path: [[-6.5, 107.5], [-7.5, 111.0], [-3.0, 114.0], [0.5, 110.0]], depth: [5, 40], shallow: 0.95 },
];

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

function gauss(r: () => number): number {
    return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

function along(path: Zone['path'], u: number): [number, number] {
    const seg = Math.min(path.length - 2, Math.floor(u * (path.length - 1)));
    const f = u * (path.length - 1) - seg;
    const a = path[seg]!;
    const b = path[seg + 1]!;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Mainshock magnitudes follow Gutenberg-Richter (b = 1, minimum 3.0, cap 8.6). Each mainshock brings aftershocks: their number grows with
 * magnitude, they stay within the rupture length of the mainshock and decay in time by Omori's law, so the catalog has dense bursts
 * in space and time, not just hot regions.
 */
export function generateCatalog(o: { count: number; seed: number; days: number; endMs?: number }): CatalogRow[] {
    const r = rng(o.seed);
    const end = o.endMs ?? Date.UTC(2026, 10, 1);
    const start = end - o.days * 86_400_000;
    const rows: CatalogRow[] = [];
    let n = 0;
    const pick = (): Zone => {
        let x = r();
        for (const z of ZONES) if ((x -= z.weight) <= 0) return z;
        return ZONES[0]!;
    };
    const push = (lat: number, lon: number, mag: number, depth: number, t: number): void => {
        if (rows.length >= o.count) return;
        const id = `cat-${o.seed}-${String(n++).padStart(7, '0')}`;
        rows.push({
            event_id: id,
            magnitude: round(mag, 1),
            depth_km: Math.round(depth),
            epicenter_lat: round(lat, 4),
            epicenter_lon: round(lon, 4),
            region_name: nearestProvince(lat, lon),
            occurred_at: new Date(t).toISOString(),
            potential_tsunami: mag >= 7.0 && depth <= 100,
        });
    };
    while (rows.length < o.count) {
        const z = pick();
        const [clat, clon] = along(z.path, r());
        const lat = clat + gauss(r) * 0.25;
        const lon = clon + gauss(r) * 0.25;
        const mag = Math.min(8.6, 3 - Math.log10(1 - r()));
        const depth = r() < z.shallow ? z.depth[0] + r() * Math.min(25, z.depth[1] - z.depth[0]) : z.depth[0] + r() * (z.depth[1] - z.depth[0]);
        const t0 = start + r() * (end - start);
        push(lat, lon, mag, depth, t0);
        const aftershocks = Math.min(400, Math.floor(10 ** (0.9 * (mag - 4.2)) * (0.5 + r())));
        const rupture = 10 ** (0.5 * mag - 1.8) / 111; // rupture length in degrees
        for (let i = 0; i < aftershocks; i++) {
            const dt = Math.min(end - t0, 3_600_000 * (0.05 / Math.max(1e-6, r())) ** 1.0); // Omori-like: most within hours, a tail over days
            push(lat + gauss(r) * rupture, lon + gauss(r) * rupture, Math.max(3, Math.min(mag - 0.8, 3 - Math.log10(1 - r()) * 0.9)), depth + gauss(r) * 5, t0 + dt);
        }
    }
    return rows.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
}

const ALIASES: Record<keyof CatalogRow | 'ignored', string[]> = {
    event_id: ['event_id', 'id', 'eventid', 'event'],
    magnitude: ['magnitude', 'mag', 'mw', 'magnitude_mw'],
    depth_km: ['depth_km', 'depth', 'depth_kilometers'],
    epicenter_lat: ['epicenter_lat', 'latitude', 'lat'],
    epicenter_lon: ['epicenter_lon', 'longitude', 'lon', 'lng'],
    region_name: ['region_name', 'place', 'region', 'area', 'area_name'],
    occurred_at: ['occurred_at', 'time', 'origin_time', 'origintime', 'datetime'],
    potential_tsunami: ['potential_tsunami', 'tsunami'],
    ignored: [],
};

function pickField(row: Record<string, unknown>, key: keyof CatalogRow): unknown {
    const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
    for (const a of ALIASES[key]) if (lower.has(a)) return lower.get(a);
    return undefined;
}

export function normalizeRow(raw: Record<string, unknown>): CatalogRow {
    const need = (k: keyof CatalogRow): unknown => {
        const v = pickField(raw, k);
        if (v === undefined || v === '') throw new Error(`catalog row has no ${k} (accepted names: ${ALIASES[k].join(', ')})`);
        return v;
    };
    const mag = Number(need('magnitude'));
    const lat = Number(need('epicenter_lat'));
    const lon = Number(need('epicenter_lon'));
    if (![mag, lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error(`catalog row has an invalid number: ${JSON.stringify(raw).slice(0, 120)}`);
    const time = new Date(String(need('occurred_at')));
    if (Number.isNaN(time.getTime())) throw new Error(`catalog row has an unparsable time: ${String(pickField(raw, 'occurred_at'))}`);
    const depth = Number(pickField(raw, 'depth_km') ?? 10);
    const region = pickField(raw, 'region_name');
    const tsunami = pickField(raw, 'potential_tsunami');
    return {
        event_id: String(need('event_id')),
        magnitude: mag,
        depth_km: Number.isFinite(depth) ? depth : 10,
        epicenter_lat: lat,
        epicenter_lon: lon,
        region_name: typeof region === 'string' && region !== '' ? region : nearestProvince(lat, lon),
        occurred_at: time.toISOString(),
        potential_tsunami: typeof tsunami === 'boolean' ? tsunami : String(tsunami).toLowerCase() === 'true' || (mag >= 7 && depth <= 100),
    };
}

/** JSON lines (one object per line) or CSV with a header row. */
export function parseCatalog(text: string): CatalogRow[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) return [];
    if (lines[0]!.trim().startsWith('{')) return lines.map((l) => normalizeRow(JSON.parse(l) as Record<string, unknown>));
    const header = lines[0]!.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map((l) => {
        const cells = l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        return normalizeRow(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
    });
}

/** Same mapping as the BMKG ingest. */
export function rowToHazard(row: CatalogRow): HazardRecord {
    return mapSeismicToHazard(row) as unknown as HazardRecord;
}

/** How concentrated a catalog is: share of events in the busiest 1-degree cell and in the busiest zone, for the report. */
export function concentration(rows: CatalogRow[]): { rows: number; busiest_cell_share: number; busiest_province_share: number; provinces: number } {
    const cells = new Map<string, number>();
    const provinces = new Map<string, number>();
    for (const r of rows) {
        const c = `${Math.floor(r.epicenter_lat)}:${Math.floor(r.epicenter_lon)}`;
        cells.set(c, (cells.get(c) ?? 0) + 1);
        provinces.set(r.region_name, (provinces.get(r.region_name) ?? 0) + 1);
    }
    return {
        rows: rows.length,
        busiest_cell_share: round(Math.max(0, ...cells.values()) / Math.max(1, rows.length), 3),
        busiest_province_share: round(Math.max(0, ...provinces.values()) / Math.max(1, rows.length), 3),
        provinces: provinces.size,
    };
}
