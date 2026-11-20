import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { correlationId, getLog } from './middleware/correlationId.js';
import { throttleFailures } from './middleware/failureThrottle.js';
import { requestLogger } from './middleware/requestLogger.js';
import { tokenRouter } from './routes/token.js';

const app = express();
app.disable('x-powered-by');

const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const counters = new Map<string, number>();
const histograms = new Map<string, { counts: number[]; sum: number; count: number }>();
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/$/, '');

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics') {
        next();
        return;
    }
    const wallStart = Date.now();
    const monoStart = performance.now();
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);

    res.on('finish', () => {
        const durSec = (performance.now() - monoStart) / 1000;
        const route = req.path;
        const ck = `${req.method}|${route}|${res.statusCode}`;
        counters.set(ck, (counters.get(ck) ?? 0) + 1);
        let h = histograms.get(route);
        if (!h) {
            h = { counts: new Array(HIST_BUCKETS.length).fill(0), sum: 0, count: 0 };
            histograms.set(route, h);
        }
        h.sum += durSec;
        h.count += 1;
        for (let i = 0; i < HIST_BUCKETS.length; i++) if (durSec <= HIST_BUCKETS[i]!) h.counts[i]! += 1;

        if (OTLP_ENDPOINT && req.path !== '/health') {
            void fetch(`${OTLP_ENDPOINT}/v1/traces`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    resourceSpans: [{
                        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'auth-service' } }] },
                        scopeSpans: [{
                            scope: { name: 'bnpb-otel' },
                            spans: [{
                                traceId,
                                spanId,
                                name: `${req.method} ${route}`,
                                kind: 2,
                                startTimeUnixNano: `${wallStart}000000`,
                                endTimeUnixNano: `${Math.trunc(wallStart + durSec * 1000)}000000`,
                                status: { code: res.statusCode < 500 ? 1 : 2 },
                                attributes: [
                                    { key: 'http.method', value: { stringValue: req.method } },
                                    { key: 'http.route', value: { stringValue: route } },
                                    { key: 'http.status_code', value: { intValue: String(res.statusCode) } },
                                    { key: 'x-correlation-id', value: { stringValue: String(res.getHeader('x-correlation-id') ?? '') } },
                                ],
                            }],
                        }],
                    }],
                }),
                signal: AbortSignal.timeout(1500),
            }).catch(() => undefined);
        }
    });
    next();
});

app.use(correlationId);
app.use(requestLogger);
app.use(express.json({ limit: '4kb' }));

app.get('/metrics', (_req: Request, res: Response) => {
    const lines = [
        '# HELP http_requests_total Total HTTP requests processed',
        '# TYPE http_requests_total counter',
    ];
    for (const [k, v] of counters.entries()) {
        const [method, route, status] = k.split('|');
        lines.push(`http_requests_total{service="auth-service",method="${method}",route="${route}",status="${status}"} ${v}`);
    }
    lines.push(
        '# HELP http_request_duration_seconds HTTP request latency in seconds',
        '# TYPE http_request_duration_seconds histogram'
    );
    for (const [route, h] of histograms.entries()) {
        for (let i = 0; i < HIST_BUCKETS.length; i++) {
            lines.push(`http_request_duration_seconds_bucket{service="auth-service",route="${route}",le="${HIST_BUCKETS[i]!}"} ${h.counts[i]!}`);
        }
        lines.push(`http_request_duration_seconds_bucket{service="auth-service",route="${route}",le="+Inf"} ${h.count}`);
        lines.push(`http_request_duration_seconds_sum{service="auth-service",route="${route}"} ${h.sum}`);
        lines.push(`http_request_duration_seconds_count{service="auth-service",route="${route}"} ${h.count}`);
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
});

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'auth-service' });
});

app.use(['/token', '/refresh'], throttleFailures);
app.use(tokenRouter);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'invalid_request', error_description: 'Body must be valid JSON' });
        return;
    }
    getLog(res).error({ error: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
    logger.info(
        { port: config.port, access_token_ttl_s: config.accessTokenTtlSeconds, refresh_token_ttl_s: config.refreshTokenTtlSeconds },
        'auth-service started'
    );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'auth-service stopped');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}
