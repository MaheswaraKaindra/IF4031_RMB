// Load test: 50 parallel connections (25 BMKG-only + 25 volcanic) for 60 seconds.
// Script: k6 run -e CLIENT_SECRET=<AUTH_CLIENT_BNPB_OPS_SECRET> load-test/events.js
// env (optional): BASE_URL, AUTH_URL, CLIENT_ID, DURATION, VUS_EACH
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:8090';
const CLIENT_ID = __ENV.CLIENT_ID || 'bnpb-ops';
const CLIENT_SECRET = __ENV.CLIENT_SECRET;
const DURATION = __ENV.DURATION || '60s';
const VUS_EACH = Number(__ENV.VUS_EACH || 25);

if (!CLIENT_SECRET) throw new Error('CLIENT_SECRET is required (-e CLIENT_SECRET=...)');

// Token per VU, refreshed before expiry because default TTL (60s) is shorter than test duration
let session = null;

function authenticate() {
    const params = { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth' } };
    let res = null;
    if (session) {
        res = http.post(`${AUTH_URL}/refresh`, JSON.stringify({ refresh_token: session.refresh }), params);
    }
    if (!res || res.status !== 200) {
        res = http.post(`${AUTH_URL}/token`, JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), params);
    }
    if (res.status !== 200) throw new Error(`Failed to acquire token: ${res.status}`);

    const body = res.json();
    session = {
        access: body.access_token,
        refresh: body.refresh_token,
        renewAt: Date.now() + (body.expires_in - 10) * 1000,
    };
}

function authHeaders() {
    if (!session || Date.now() >= session.renewAt) authenticate();
    return { headers: { Authorization: `Bearer ${session.access}` }, tags: { endpoint: 'events' } };
}

const rejected429 = new Counter('rejected_429');
const staleVolcanic = new Rate('stale_volcanic');

// 429 is not counted as a failed request
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
    scenarios: {
        bmkg_only: { executor: 'constant-vus', vus: VUS_EACH, duration: DURATION, exec: 'bmkgOnly' },
        volcanic: { executor: 'constant-vus', vus: VUS_EACH, duration: DURATION, exec: 'volcanic' },
    },
    thresholds: {
        'http_req_duration{scenario:bmkg_only,endpoint:events}': ['p(95)<300'],
        http_req_failed: ['rate<0.01'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function record(res) {
    if (res.status === 429) rejected429.add(1);
    check(res, { 'status 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export function bmkgOnly() {
    record(http.get(`${BASE_URL}/events?hazard_type=SEISMIC&limit=20`, authHeaders()));
}

export function volcanic() {
    const res = http.get(`${BASE_URL}/events?hazard_type=VOLCANIC&limit=20`, authHeaders());
    record(res);
    if (res.status === 200) staleVolcanic.add(res.json('sources.PVMBG.stale') === true);
}
