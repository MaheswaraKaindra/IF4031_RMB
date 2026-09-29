// Load test: 50 koneksi paralel (25 BMKG-only + 25 vulkanik) selama 60 detik.
// Script: k6 run load-test/events.js
// env (optional): BASE_URL, DURATION, VUS_EACH
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const DURATION = __ENV.DURATION || '60s';
const VUS_EACH = Number(__ENV.VUS_EACH || 25);

const rejected429 = new Counter('rejected_429');
const staleVolcanic = new Rate('stale_volcanic');

// 429 tidak dihitung sebagai request gagal
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
    scenarios: {
        bmkg_only: { executor: 'constant-vus', vus: VUS_EACH, duration: DURATION, exec: 'bmkgOnly' },
        volcanic: { executor: 'constant-vus', vus: VUS_EACH, duration: DURATION, exec: 'volcanic' },
    },
    thresholds: {
        'http_req_duration{scenario:bmkg_only}': ['p(95)<300'],
        http_req_failed: ['rate<0.01'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function record(res) {
    if (res.status === 429) rejected429.add(1);
    check(res, { 'status 200 atau 429': (r) => r.status === 200 || r.status === 429 });
}

export function bmkgOnly() {
    record(http.get(`${BASE_URL}/events?hazard_type=SEISMIC&limit=20`));
}

export function volcanic() {
    const res = http.get(`${BASE_URL}/events?hazard_type=VOLCANIC&limit=20`);
    record(res);
    if (res.status === 200) staleVolcanic.add(res.json('sources.PVMBG.stale') === true);
}
