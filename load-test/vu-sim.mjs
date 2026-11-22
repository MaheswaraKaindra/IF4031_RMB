// P2 load generator for >= 10,000 virtual users on a machine that cannot run 10,000 k6 VUs (k6 needs several MB per VU).
// Each virtual user is an independent asynchronous loop: wait a random start offset, then GET /events?limit=20 with the shared bearer token, wait its think time, repeat,
// for the whole duration. Requests use Node's built-in fetch (keep-alive connections), so memory stays in the tens of MB. The offered load is VUS / THINK_S requests per second.
//   node load-test/vu-sim.mjs  (env: BASE_URL AUTH_URL CLIENT_SECRET [CLIENT_ID=bnpb-ops] [VUS=10000] [THINK_S=120] [DURATION_S=180] [OUT=/tmp/vu-sim.json])
// Counts per second: 200 answers, 429 (controlled rejection), every other outcome (an error). Prints the totals and the seconds that had errors.
const BASE = process.env.BASE_URL, AUTH = process.env.AUTH_URL, SECRET = process.env.CLIENT_SECRET, ID = process.env.CLIENT_ID || 'bnpb-ops';
const VUS = Number(process.env.VUS || 10000), THINK = Number(process.env.THINK_S || 120) * 1000, DURATION = Number(process.env.DURATION_S || 180) * 1000;
if (!BASE || !AUTH || !SECRET) throw new Error('BASE_URL, AUTH_URL and CLIENT_SECRET are required');
let token = '';
async function refresh() {
    const r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: ID, client_secret: SECRET }), signal: AbortSignal.timeout(10000) });
    token = (await r.json()).access_token;
}
await refresh(); setInterval(() => refresh().catch(() => {}), 40000).unref();
const t0 = Date.now(), perSec = new Map(), lat = [], errs = {};
let active = 0, maxActive = 0;
const bucket = () => { const s = Math.floor((Date.now() - t0) / 1000); let b = perSec.get(s); if (!b) { b = { ok: 0, r429: 0, err: 0 }; perSec.set(s, b); } return b; };
async function one() {
    const s = performance.now();
    try {
        const r = await fetch(`${BASE}/events?limit=20`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
        await r.arrayBuffer();
        const b = bucket(); if (r.status === 200) b.ok++; else if (r.status === 429) b.r429++; else { b.err++; errs[r.status] = (errs[r.status] || 0) + 1; }
    } catch (e) { bucket().err++; const k = e.cause?.code || e.name; errs[k] = (errs[k] || 0) + 1; }
    lat.push(performance.now() - s);
}
async function vu() {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, Math.random() * THINK));
    while (Date.now() - t0 < DURATION) { await one(); await new Promise((r) => setTimeout(r, THINK * (0.8 + Math.random() * 0.4))); }
    active--;
}
await Promise.all(Array.from({ length: VUS }, vu));
lat.sort((a, b) => a - b); const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0);
let ok = 0, r429 = 0, err = 0; for (const b of perSec.values()) { ok += b.ok; r429 += b.r429; err += b.err; }
const out = { virtual_users: VUS, max_concurrent_users: maxActive, duration_s: DURATION / 1000, think_s: THINK / 1000, requests: ok + r429 + err, ok_200: ok, controlled_429: r429, errors: err, error_rate_outside_429: +(err / Math.max(1, ok + err)).toFixed(5), error_kinds: errs, latency_ms: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(lat[lat.length - 1] || 0) }, seconds_with_errors: [...perSec].filter(([, b]) => b.err).map(([s, b]) => ({ s, err: b.err })) };
console.log(JSON.stringify(out, null, 1)); if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, JSON.stringify(out));
process.exit(0);
