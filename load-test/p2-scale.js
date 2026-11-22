// M2 P2 load test: >= 10,000 VUs sustained >= 120s (runs outside application pods).
// Usage: k6 run -e CLIENT_SECRET=<AUTH_CLIENT_BNPB_OPS_SECRET> load-test/p2-scale.js
// Optional env: BASE_URL, AUTH_URL, CLIENT_ID, VUS (default 10000), DURATION (default 120s), ACCESS_TOKEN
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:8090';
const CLIENT_ID = __ENV.CLIENT_ID || 'bnpb-ops';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const VUS = Number(__ENV.VUS || 10000);
const DURATION = __ENV.DURATION || '120s';

const rejected429 = new Counter('controlled_rejected_429');
const ok200 = new Counter('ok_200');
// RATE (requests/s) switches to an open model: a fixed arrival rate with up to VUS virtual users, so a slow system shows up as latency
// and errors instead of silently lowering the offered load. Without RATE it keeps the original closed model (VUS constant users).
const RATE = Number(__ENV.RATE || 0);
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
    scenarios: {
        sustained_10k: RATE > 0
            ? { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: Math.min(VUS, 500), maxVUs: VUS }
            : { executor: 'constant-vus', vus: VUS, duration: DURATION },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
    if (__ENV.ACCESS_TOKEN) return { token: __ENV.ACCESS_TOKEN, refresh: null, issuedAt: Date.now() };
    if (!CLIENT_SECRET) throw new Error('CLIENT_SECRET or ACCESS_TOKEN is required');
    const res = http.post(
        `${AUTH_URL}/token`,
        JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
        { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.status !== 200) throw new Error(`auth failed: ${res.status}`);
    const body = res.json();
    return { token: body.access_token, refresh: body.refresh_token, issuedAt: Date.now() };
}

let localToken = null;
let lastRefreshAt = 0;

export default function (data) {
    if (!localToken) {
        localToken = data.token;
        lastRefreshAt = data.issuedAt;
    }
    // Refresh gently per VU if test exceeds token TTL (default 60s)
    if (CLIENT_SECRET && Date.now() - lastRefreshAt > 45000) {
        const res = http.post(
            `${AUTH_URL}/token`,
            JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
            { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth' } }
        );
        if (res.status === 200) {
            localToken = res.json('access_token');
            lastRefreshAt = Date.now();
        }
    }

    const res = http.get(`${BASE_URL}/events?limit=20`, {
        headers: { Authorization: `Bearer ${localToken}` },
        tags: { endpoint: 'events' },
    });
    if (res.status === 429) rejected429.add(1);
    if (res.status === 200) ok200.add(1);
    if (__ENV.LOG_ERRORS && res.status !== 200 && res.status !== 429 && (__ENV.LOG_ERRORS === 'all' || Math.random() < 0.05)) console.warn(`status=${res.status} error=${res.error || ''} duration=${Math.round(res.timings.duration)}ms`);
    check(res, { 'status is 200 or 429': (r) => r.status === 200 || r.status === 429 });
    if (RATE === 0) sleep(0.5);
}
