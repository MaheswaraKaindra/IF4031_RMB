import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

function esc(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function fmtLabels(labels: Record<string, string>): string {
    const e = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
}

const counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();
const histograms = new Map<string, { name: string; labels: Record<string, string>; counts: number[]; sum: number; count: number }>();

function incCounter(name: string, labels: Record<string, string>): void {
    const key = `${name}${fmtLabels(labels)}`;
    const cur = counters.get(key);
    if (cur) cur.value += 1;
    else counters.set(key, { name, labels, value: 1 });
}

function observeHist(name: string, labels: Record<string, string>, val: number): void {
    const key = `${name}${fmtLabels(labels)}`;
    let h = histograms.get(key);
    if (!h) {
        h = { name, labels, counts: new Array(HIST_BUCKETS.length).fill(0), sum: 0, count: 0 };
        histograms.set(key, h);
    }
    h.sum += val;
    h.count += 1;
    for (let i = 0; i < HIST_BUCKETS.length; i++) {
        if (val <= HIST_BUCKETS[i]!) h.counts[i]! += 1;
    }
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/$/, '');

interface SpanItem {
    traceId: string;
    spanId: string;
    parentSpanId?: string | undefined;
    name: string;
    startMs: number;
    endMs: number;
    status: number;
    correlationId: string;
    route: string;
    method: string;
}

const spanQueue: SpanItem[] = [];
let flushPending = false;

async function flushSpans(): Promise<void> {
    flushPending = false;
    if (!OTLP_ENDPOINT || spanQueue.length === 0) {
        spanQueue.length = 0;
        return;
    }
    const batch = spanQueue.splice(0, 200);
    try {
        await fetch(`${OTLP_ENDPOINT}/v1/traces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                resourceSpans: [{
                    resource: {
                        attributes: [
                            { key: 'service.name', value: { stringValue: 'client-api' } },
                            { key: 'k8s.pod.name', value: { stringValue: process.env.POD_NAME || process.env.HOSTNAME || 'client-api' } },
                        ],
                    },
                    scopeSpans: [{
                        scope: { name: 'bnpb-otel' },
                        spans: batch.map((s) => ({
                            traceId: s.traceId,
                            spanId: s.spanId,
                            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                            name: s.name,
                            kind: 2,
                            startTimeUnixNano: `${Math.trunc(s.startMs)}000000`,
                            endTimeUnixNano: `${Math.trunc(s.endMs)}000000`,
                            status: { code: s.status < 500 ? 1 : 2 },
                            attributes: [
                                { key: 'http.method', value: { stringValue: s.method } },
                                { key: 'http.route', value: { stringValue: s.route } },
                                { key: 'http.status_code', value: { intValue: String(s.status) } },
                                { key: 'x-correlation-id', value: { stringValue: s.correlationId } },
                            ],
                        })),
                    }],
                }],
            }),
            signal: AbortSignal.timeout(1500),
        });
    } catch {
        // Non-blocking telemetry
    }
}

export function observabilityMiddleware(serviceName: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (req.path === '/metrics') {
            next();
            return;
        }
        const m = TRACEPARENT_RE.exec(req.header('traceparent') ?? '');
        const traceId = m ? m[1]!.toLowerCase() : randomBytes(16).toString('hex');
        const parentSpanId = m ? m[2]!.toLowerCase() : undefined;
        const spanId = randomBytes(8).toString('hex');
        const traceparent = `00-${traceId}-${spanId}-01`;
        res.locals.traceId = traceId;
        res.locals.spanId = spanId;
        res.locals.traceparent = traceparent;
        res.setHeader('traceparent', traceparent);

        const wallStart = Date.now();
        const monoStart = performance.now();
        res.on('finish', () => {
            const durSec = (performance.now() - monoStart) / 1000;
            const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
            incCounter('http_requests_total', { service: serviceName, method: req.method, route, status: String(res.statusCode) });
            observeHist('http_request_duration_seconds', { service: serviceName, route }, durSec);
            if (OTLP_ENDPOINT && req.path !== '/health') {
                if (spanQueue.length >= 1000) spanQueue.shift();
                spanQueue.push({
                    traceId,
                    spanId,
                    parentSpanId,
                    name: `${req.method} ${route}`,
                    startMs: wallStart,
                    endMs: wallStart + durSec * 1000,
                    status: res.statusCode,
                    correlationId: String(res.getHeader('x-correlation-id') ?? ''),
                    route,
                    method: req.method,
                });
                if (!flushPending) {
                    flushPending = true;
                    setTimeout(() => void flushSpans(), 500).unref();
                }
            }
        });
        next();
    };
}

export function renderMetrics(): string {
    const lines = [
        '# HELP http_requests_total Total HTTP requests processed',
        '# TYPE http_requests_total counter',
    ];
    for (const c of counters.values()) lines.push(`${c.name}${fmtLabels(c.labels)} ${c.value}`);
    lines.push(
        '# HELP http_request_duration_seconds HTTP request latency in seconds',
        '# TYPE http_request_duration_seconds histogram'
    );
    for (const h of histograms.values()) {
        for (let i = 0; i < HIST_BUCKETS.length; i++) {
            lines.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: String(HIST_BUCKETS[i]!) })} ${h.counts[i]!}`);
        }
        lines.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: '+Inf' })} ${h.count}`);
        lines.push(`${h.name}_sum${fmtLabels(h.labels)} ${h.sum}`);
        lines.push(`${h.name}_count${fmtLabels(h.labels)} ${h.count}`);
    }
    return lines.join('\n') + '\n';
}
