// HPA proof load (bonus: capacity that follows the load). A closed-loop ramp of GET /events users, with no think time, so the CPU of client-api and the aggregator rises and falls with the user count:
//   0 -> LOW (warm-up), up to PEAK, hold at PEAK, back down to LOW, then to 0. The replica counts are sampled by scripts/m2/hpa-ramp.sh.
//   k6 run -e BASE_URL=... -e AUTH_URL=... -e CLIENT_SECRET=<ops secret> [-e PEAK=60 -e LOW=5 -e UP_S=90 -e HOLD_S=90 -e DOWN_S=60] load-test/hpa-ramp.js
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:8090';
const CLIENT_ID = __ENV.CLIENT_ID || 'bnpb-ops';
const CLIENT_SECRET = __ENV.CLIENT_SECRET;
const PEAK = Number(__ENV.PEAK || 60), LOW = Number(__ENV.LOW || 5);
const UP_S = Number(__ENV.UP_S || 90), HOLD_S = Number(__ENV.HOLD_S || 90), DOWN_S = Number(__ENV.DOWN_S || 60);
if (!CLIENT_SECRET) throw new Error('CLIENT_SECRET is required');
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
    scenarios: {
        ramp: {
            executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '5s',
            stages: [
                { duration: '20s', target: LOW },
                { duration: `${UP_S}s`, target: PEAK },
                { duration: `${HOLD_S}s`, target: PEAK },
                { duration: `${DOWN_S}s`, target: LOW },
                { duration: '20s', target: 0 },
            ],
        },
    },
    summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
};

export function setup() {
    const r = http.post(`${AUTH_URL}/token`, JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), { headers: { 'Content-Type': 'application/json' } });
    if (r.status !== 200) throw new Error(`auth failed: ${r.status}`);
    return { token: r.json('access_token'), at: Date.now() };
}
let token = null, tokenAt = 0;
export default function (data) {
    if (!token) { token = data.token; tokenAt = data.at; }
    if (Date.now() - tokenAt > 40000) { // access tokens live 60 s
        const r = http.post(`${AUTH_URL}/token`, JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), { headers: { 'Content-Type': 'application/json' } });
        if (r.status === 200) { token = r.json('access_token'); tokenAt = Date.now(); }
    }
    const res = http.get(`${BASE_URL}/events?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    check(res, { 'status 200 or 429': (r) => r.status === 200 || r.status === 429 });
}
