import express, { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger, requestLogger } from './logger';

const app = express();

type SchemaMode =
    | 'baseline'
    | 'additive'
    | 'incompatible_rename'
    | 'incompatible_type'
    | 'incompatible_missing'
    | 'mixed_incompatible';

type MalformedMode = 'none' | 'truncated_json' | 'deeply_nested' | 'invalid_utf8' | 'oversized';

const requestCounts = new Map<string, number>();
const upstreamPollCounts = new Map<string, number>();
const durationStats = { sum: 0, count: 0 };

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics') {
        next();
        return;
    }
    const start = performance.now();
    res.on('finish', () => {
        const dur = (performance.now() - start) / 1000;
        durationStats.sum += dur;
        durationStats.count += 1;
        const key = `${req.method}|${req.path}|${res.statusCode}`;
        requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    });
    next();
});

app.use(requestLogger);
app.use(express.json());

const PORT = process.env.PVMBG_PORT || 8082;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const TOKEN_SHA256 = process.env.PVMBG_TOKEN_SHA256;
if (!TOKEN_SHA256 || !SHA256_HEX.test(TOKEN_SHA256)) {
    logger.fatal('PVMBG_TOKEN_SHA256 must be set to the SHA-256 hash (64 hex chars) of the PVMBG token');
    process.exit(1);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const TOKEN_DIGEST = Buffer.from(TOKEN_SHA256, 'hex');

let isOutage = false;
let schemaMode: SchemaMode = 'baseline';
let malformedMode: MalformedMode = 'none';
let malformedOnce = false;

const REPORT_INTERVAL_MS = parseInt(process.env.PVMBG_REPORT_INTERVAL_MS || '10000', 10);
const DELAY_MIN_MS = parseInt(process.env.PVMBG_DELAY_MIN_MS || '500', 10);
const DELAY_MAX_MS = parseInt(process.env.PVMBG_DELAY_MAX_MS || '3000', 10);
const RUN_ID = Date.now().toString(36);

function createVolcanicReport(n: number, reportedAt: Date) {
    return {
        report_id: `REP-VOLC-${RUN_ID}-${n}`,
        volcano_id: `VOLC-0${(n % 5) + 1}`,
        alert_level: ['Normal', 'Waspada', 'Siaga', 'Awas'][Math.floor(Math.random() * 4)],
        eruption_count_24h: Math.floor(Math.random() * 10),
        ash_column_height_m: +(Math.random() * 5000).toFixed(1),
        reported_at: reportedAt.toISOString(),
    };
}

const volcanicReports = Array.from({ length: 20 }).map((_, i) =>
    createVolcanicReport(i, new Date(Date.now() - i * 3600000))
);

let nextReportNumber = volcanicReports.length;
setInterval(() => {
    volcanicReports.push(createVolcanicReport(nextReportNumber++, new Date()));
}, REPORT_INTERVAL_MS);

app.get('/health', (_req: Request, res: Response) => res.status(200).json({ status: 'ok', service: 'mock-pvmbg' }));

app.get('/metrics', (_req: Request, res: Response) => {
    const lines = [
        '# HELP http_requests_total Total HTTP requests processed',
        '# TYPE http_requests_total counter',
    ];
    for (const [k, v] of requestCounts.entries()) {
        const [method, route, status] = k.split('|');
        lines.push(`http_requests_total{service="mock-pvmbg",method="${method}",route="${route}",status="${status}"} ${v}`);
    }
    lines.push(
        '# HELP http_request_duration_seconds HTTP request latency in seconds',
        '# TYPE http_request_duration_seconds histogram',
        `http_request_duration_seconds_bucket{service="mock-pvmbg",route="/volcanic-reports",le="+Inf"} ${durationStats.count}`,
        `http_request_duration_seconds_sum{service="mock-pvmbg",route="/volcanic-reports"} ${durationStats.sum}`,
        `http_request_duration_seconds_count{service="mock-pvmbg",route="/volcanic-reports"} ${durationStats.count}`,
        '# HELP upstream_polls_total Total upstream polls received per aggregator pod',
        '# TYPE upstream_polls_total counter'
    );
    for (const [pod, v] of upstreamPollCounts.entries()) {
        lines.push(`upstream_polls_total{service="mock-pvmbg",caller_pod="${pod}"} ${v}`);
    }
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

// ADMIN_OPEN=1 (set only in the Kubernetes manifests): /admin/* is callable without the token. The official Tester Agent calls these
// endpoints from inside the cluster and holds no secrets, so with the token required its `schema` scenario fails with HTTP 401.
// Docker Compose keeps the token requirement (variable unset).
const ADMIN_OPEN = process.env.ADMIN_OPEN === '1';

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health' || req.path === '/metrics') return next();
    if (ADMIN_OPEN && req.path.startsWith('/admin')) return next();

    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (bearer === undefined) {
        return res.status(401).json({ error: 'Authorization header: Bearer <pvmbg-token> is required' });
    }
    if (!timingSafeEqual(sha256(bearer), TOKEN_DIGEST)) {
        res.locals.log.warn('credential rejected');
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (isOutage && !req.path.startsWith('/admin')) {
        return res.status(503).json({ error: 'Service Unavailable (Outage)' });
    }

    if (!req.path.startsWith('/admin')) {
        const delay = DELAY_MIN_MS + Math.floor(Math.random() * (Math.max(DELAY_MAX_MS - DELAY_MIN_MS, 0) + 1));
        setTimeout(next, delay);
    } else {
        next();
    }
});

function transformBySchemaMode(rep: ReturnType<typeof createVolcanicReport>, index: number): Record<string, unknown> {
    if (schemaMode === 'additive') {
        return { ...rep, confidence_level: +(Math.random() * 0.5 + 0.5).toFixed(2) };
    }
    if (schemaMode === 'incompatible_rename') {
        const { volcano_id, alert_level, ...rest } = rep;
        return { ...rest, mountain_code: volcano_id, status_level: alert_level };
    }
    if (schemaMode === 'incompatible_type') {
        return { ...rep, eruption_count_24h: 'three', ash_column_height_m: 'very_high' };
    }
    if (schemaMode === 'incompatible_missing') {
        const { alert_level: _a, volcano_id: _v, ...rest } = rep;
        void _a;
        void _v;
        return rest;
    }
    if (schemaMode === 'mixed_incompatible') {
        const mod = index % 4;
        if (mod === 0) {
            const { volcano_id, alert_level, ...rest } = rep;
            return { ...rest, mountain_code: volcano_id, status_level: alert_level };
        }
        if (mod === 1) {
            return { ...rep, eruption_count_24h: 'three', ash_column_height_m: 'high' };
        }
        if (mod === 2) {
            const { alert_level: _a, volcano_id: _v, ...rest } = rep;
            void _a;
            void _v;
            return rest;
        }
        return { ...rep, confidence_level: 0.88 };
    }
    return rep;
}

app.get('/volcanic-reports', (req: Request, res: Response) => {
    const callerPod = req.header('x-aggregator-pod') || 'unknown';
    const leaderEpoch = req.header('x-leader-epoch') || 'none';
    upstreamPollCounts.set(callerPod, (upstreamPollCounts.get(callerPod) ?? 0) + 1);
    res.locals.log.info({ caller_pod: callerPod, leader_epoch: leaderEpoch, schema_mode: schemaMode }, 'upstream poll served');

    const activeMalformed = malformedMode;
    if (malformedOnce && activeMalformed !== 'none') {
        malformedMode = 'none';
        malformedOnce = false;
    }
    if (activeMalformed === 'truncated_json') {
        res.status(200).type('application/json').send('[{"report_id":"REP-TRUNC-1","volcano_id":"VOLC-01"');
        return;
    }
    if (activeMalformed === 'deeply_nested') {
        const open = '['.repeat(50);
        const close = ']'.repeat(50);
        res.status(200).type('application/json').send(`${open}1${close}`);
        return;
    }
    if (activeMalformed === 'invalid_utf8') {
        res.status(200).type('application/json').send(Buffer.from([0x5b, 0x7b, 0xff, 0xfe, 0x7d, 0x5d]));
        return;
    }
    if (activeMalformed === 'oversized') {
        const pad = 'x'.repeat(300 * 1024);
        res.status(200).type('application/json').send(JSON.stringify([{ report_id: 'REP-BIG', padding: pad }]));
        return;
    }

    const since = req.query.since ? new Date(req.query.since as string) : new Date(0);
    const filtered = volcanicReports.filter((rep) => new Date(rep.reported_at) >= since);
    const responseData = filtered.map((rep, idx) => transformBySchemaMode(rep, idx));
    res.json(responseData);
});

const VALID_MODES = new Set<SchemaMode>([
    'baseline',
    'additive',
    'incompatible_rename',
    'incompatible_type',
    'incompatible_missing',
    'mixed_incompatible',
]);

app.get('/admin/schema-version', (_req, res) => {
    res.json({ mode: schemaMode, malformed_mode: malformedMode });
});

app.post('/admin/schema-version', (req, res) => {
    const requested = (req.body?.mode ?? req.query.mode) as string | undefined;
    if (requested === undefined || requested === 'toggle') {
        schemaMode = schemaMode === 'baseline' ? 'additive' : 'baseline';
    } else if (VALID_MODES.has(requested as SchemaMode)) {
        schemaMode = requested as SchemaMode;
    } else {
        return res.status(400).json({ error: `Invalid schema mode: ${requested}` });
    }
    res.locals.log.info({ schema_mode: schemaMode, confidence_level_enabled: schemaMode === 'additive' }, 'schema version updated');
    res.json({ mode: schemaMode, message: `PVMBG schema mode set to: ${schemaMode}` });
});

app.post('/admin/malformed', (req, res) => {
    const mode = (req.body?.mode ?? req.query.mode ?? 'none') as MalformedMode;
    const valid: readonly MalformedMode[] = ['none', 'truncated_json', 'deeply_nested', 'invalid_utf8', 'oversized'];
    if (!valid.includes(mode)) {
        return res.status(400).json({ error: `Invalid malformed mode: ${mode}` });
    }
    malformedMode = mode;
    malformedOnce = Boolean(req.body?.once ?? false);
    res.locals.log.warn({ malformed_mode: malformedMode, once: malformedOnce }, 'malformed payload mode updated');
    res.json({ malformed_mode: malformedMode, once: malformedOnce });
});

app.post('/admin/outage', (_req, res) => {
    isOutage = !isOutage;
    res.locals.log.warn({ outage: isOutage }, 'outage toggled');
    res.json({ outage: isOutage, message: `Current PVMBG outage status: ${isOutage}` });
});

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'Mock PVMBG started'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'mock-pvmbg shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}
