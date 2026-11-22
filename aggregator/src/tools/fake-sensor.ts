// Test double for the Sensor Pantai contract (Appendix C). It is NOT the vendor image: it only exists to provoke misbehaviour
// the practice profile never shows. Deploy it next to the real sensor and point SENSOR_PANTAI_URL at it for a test.
//   POST /admin/mode  {"mode":"normal|slow|blackhole|status|malformed|stale|frozen", "delay_ms":2500, "status":503}
//   POST /admin/enqueue {"items":[ ...raw observation objects, appended verbatim... ]}
//   POST /admin/burst   {"count":20000,"critical_every":0}
//   POST /admin/reset   restart the log and the virtual clock (a sensor restart)
// Env: PANTAI_AUTH_TOKEN, PORT (8080), SPEED (60).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const TOKEN = process.env.PANTAI_AUTH_TOKEN ?? '';
const PORT = Number(process.env.PORT || 8080);
const SPEED = Number(process.env.SPEED || 60);
const STATIONS = [
    { station_id: 'stn-padang-01', name: 'Padang', province: 'Sumatera Barat', latitude: -0.9492, longitude: 100.3543 },
    { station_id: 'stn-banda-aceh-01', name: 'Banda Aceh', province: 'Aceh', latitude: 5.5483, longitude: 95.3238 },
    { station_id: 'stn-cilacap-01', name: 'Cilacap', province: 'Jawa Tengah', latitude: -7.7279, longitude: 109.015 },
    { station_id: 'stn-pelabuhan-ratu-01', name: 'Pelabuhan Ratu', province: 'Jawa Barat', latitude: -6.9868, longitude: 106.55 },
];
const EPOCH = Date.parse('2026-11-12T00:00:00Z');

let log: Record<string, unknown>[] = [];
let startedAt = Date.now();
let generated = 0;
let mode = 'normal';
let delayMs = 0;
let statusCode = 503;
let frozenVirtualMs: number | undefined;
let pausedAtVirtualMs: number | undefined;

const virtualNow = (): number => frozenVirtualMs ?? EPOCH + (Date.now() - startedAt) * SPEED;
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

function generate(): void {
    const limit = pausedAtVirtualMs ?? virtualNow();
    while (EPOCH + generated * 15_000 <= limit) {
        const n = generated++;
        log.push({
            observation_id: `fk-${String(n).padStart(6, "0")}`,
            station_id: STATIONS[n % 4]!.station_id,
            observed_at: iso(EPOCH + n * 15_000),
            sea_level_anomaly_m: Math.round(Math.sin(n) * 30) / 100,
            wave_height_m: Math.round((1 + Math.cos(n / 3)) * 100) / 100,
            quality: 'ok',
            critical: false,
        });
    }
}

function body(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
    });
}

function send(res: ServerResponse, code: number, payload: unknown): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(text);
}

createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: { code: 'unauthorized', message: 'bad token' } });

    if (url.pathname.startsWith('/admin/')) {
        const b = await body(req);
        if (url.pathname === '/admin/mode') {
            mode = String(b.mode ?? 'normal');
            delayMs = Number(b.delay_ms ?? 0);
            statusCode = Number(b.status ?? 503);
            if (mode === 'stale') pausedAtVirtualMs = virtualNow();
            else pausedAtVirtualMs = undefined;
            if (mode === 'frozen') frozenVirtualMs = virtualNow();
            else if (frozenVirtualMs !== undefined) {
                startedAt = Date.now() - (frozenVirtualMs - EPOCH) / SPEED;
                frozenVirtualMs = undefined;
            }
        } else if (url.pathname === '/admin/enqueue') {
            for (const it of b.items ?? []) log.push(it);
        } else if (url.pathname === '/admin/burst') {
            generate();
            const base = log.length;
            for (let i = 0; i < Number(b.count ?? 1000); i++) {
                const n = base + i;
                log.push({
                    observation_id: `burst-${n}`,
                    station_id: STATIONS[n % 4]!.station_id,
                    observed_at: iso(virtualNow()),
                    sea_level_anomaly_m: 0.1,
                    wave_height_m: 1.2,
                    quality: 'ok',
                    critical: Number(b.critical_every ?? 0) > 0 && i % Number(b.critical_every) === 0,
                });
            }
        } else if (url.pathname === '/admin/reset') {
            log = [];
            generated = 0;
            startedAt = Date.now();
        } else return send(res, 404, {});
        return send(res, 200, { mode, delay_ms: delayMs, log_length: log.length });
    }

    if (mode === 'blackhole') return; // never answers
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (mode === 'status') return send(res, statusCode, { error: { code: 'unavailable', message: 'injected' } });
    if (mode === 'malformed') return send(res, 200, '{"items":[{"observation_id":');

    if (url.pathname === '/v1/stations') return send(res, 200, { items: STATIONS });
    if (url.pathname === '/v1/observations') {
        generate();
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const cursor = url.searchParams.get('cursor');
        let from = 0;
        if (cursor) {
            try {
                from = JSON.parse(Buffer.from(cursor, 'base64url').toString()).o;
            } catch {
                return send(res, 400, { error: { code: 'bad_request', message: 'cursor tidak valid' } });
            }
        }
        const items = log.slice(from, from + limit);
        const next = from + items.length;
        return send(res, 200, {
            generated_at: iso(virtualNow()),
            items,
            next_cursor: items.length ? Buffer.from(JSON.stringify({ o: next })).toString('base64url') : null,
        });
    }
    return send(res, 404, {});
}).listen(PORT, () => console.log(`fake sensor on :${PORT}`));
