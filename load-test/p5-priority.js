// P5 criterion 5: a Media flood must not take capacity from Tim Lapangan, for reads (GET /events) and for writes (POST /field-reports).
// k6 run -e FIELD_SECRET=... -e MEDIA_SECRET=... [-e MEDIA_VUS=200 -e FIELD_VUS=20 -e DURATION=30s] load-test/p5-priority.js
// env (optional): BASE_URL, AUTH_URL
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:8090';
const DURATION = __ENV.DURATION || '30s';
const FIELD_VUS = Number(__ENV.FIELD_VUS || 20);
const POST_VUS = Number(__ENV.POST_VUS || 5);
const MEDIA_VUS_ENV = __ENV.MEDIA_VUS;
const MEDIA_VUS = Number(MEDIA_VUS_ENV === undefined ? 200 : MEDIA_VUS_ENV);
if (!__ENV.FIELD_SECRET || !__ENV.MEDIA_SECRET) throw new Error('FIELD_SECRET and MEDIA_SECRET are required');

const SECRETS = { 'field-team': __ENV.FIELD_SECRET, media: __ENV.MEDIA_SECRET };
let session = null;

function login(clientId) {
    const params = { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth' } };
    let res = session ? http.post(`${AUTH_URL}/refresh`, JSON.stringify({ refresh_token: session.refresh }), params) : null;
    if (!res || res.status !== 200) res = http.post(`${AUTH_URL}/token`, JSON.stringify({ client_id: clientId, client_secret: SECRETS[clientId] }), params);
    if (res.status !== 200) throw new Error(`token ${res.status}`);
    const b = res.json();
    session = { access: b.access_token, refresh: b.refresh_token, renewAt: Date.now() + (b.expires_in - 10) * 1000 };
}

function call(clientId, tag) {
    if (!session || Date.now() >= session.renewAt) login(clientId);
    return http.get(`${BASE_URL}/events?limit=20`, { headers: { Authorization: `Bearer ${session.access}` }, tags: { endpoint: 'events', client: tag } });
}

const acceptedPost = new Counter('accepted_field_report');
const refusedPost = new Counter('refused_field_report');
const rejected = { field_team: new Counter('rejected_field_team'), media: new Counter('rejected_media') };
const served = { field_team: new Counter('served_field_team'), media: new Counter('served_media') };
http.setResponseCallback(http.expectedStatuses(200, 202, 429));

export const options = {
    scenarios: {
        field_team: { executor: 'constant-vus', vus: FIELD_VUS, duration: DURATION, exec: 'fieldTeam' },
        field_post: { executor: 'constant-vus', vus: POST_VUS, duration: DURATION, exec: 'fieldPost' },
        ...(MEDIA_VUS > 0 ? { media_flood: { executor: 'constant-vus', vus: MEDIA_VUS, duration: DURATION, exec: 'media' } } : {}),
    },
    thresholds: {
        rejected_field_team: ['count==0'],
        'http_req_duration{client:field_team}': ['p(95)<1000'],
        accepted_field_report: ['count>0'],
        refused_field_report: ['count==0'],
    },
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function record(cls, res) {
    if (res.status === 429) rejected[cls].add(1);
    else if (res.status === 200) served[cls].add(1);
    check(res, { 'status 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export function fieldTeam() {
    record('field_team', call('field-team', 'field_team'));
}

export function fieldPost() {
    if (!session || Date.now() >= session.renewAt) login('field-team');
    const id = `k6-${__VU}-${__ITER}-${Date.now()}`;
    const body = JSON.stringify({ report_id: id, hazard_type: 'COASTAL', severity: 'WASPADA', area_name: 'k6', latitude: -6.2, longitude: 106.8, occurred_at: new Date().toISOString(), attributes: { source: 'k6' } });
    const res = http.post(`${BASE_URL}/field-reports`, body, { headers: { Authorization: `Bearer ${session.access}`, 'Content-Type': 'application/json', 'Idempotency-Key': id }, tags: { endpoint: 'field_reports', client: 'field_post' } });
    if (res.status === 202) acceptedPost.add(1);
    else refusedPost.add(1);
    check(res, { 'report accepted 202': (r) => r.status === 202 });
}

export function media() {
    record('media', call('media', 'media'));
}
