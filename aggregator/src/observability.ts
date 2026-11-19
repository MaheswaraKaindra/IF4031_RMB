import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;

interface LabelledKey {
    name: string;
    labels: Record<string, string>;
}

function escapeLabelValue(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function seriesKey(name: string, labels: Record<string, string>): string {
    return `${name}${formatLabels(labels)}`;
}

class MetricsRegistry {
    private readonly counters = new Map<string, { meta: LabelledKey; value: number }>();
    private readonly gauges = new Map<string, { meta: LabelledKey; value: number }>();
    private readonly histograms = new Map<
        string,
        { meta: LabelledKey; counts: number[]; sum: number; count: number }
    >();
    private readonly helps = new Map<string, { type: 'counter' | 'gauge' | 'histogram'; help: string }>();

    register(name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void {
        if (!this.helps.has(name)) this.helps.set(name, { type, help });
    }

    inc(name: string, labels: Record<string, string> = {}, delta = 1): void {
        const key = seriesKey(name, labels);
        const cur = this.counters.get(key);
        if (cur) cur.value += delta;
        else this.counters.set(key, { meta: { name, labels }, value: delta });
    }

    set(name: string, labels: Record<string, string>, value: number): void {
        const key = seriesKey(name, labels);
        this.gauges.set(key, { meta: { name, labels }, value });
    }

    observe(name: string, labels: Record<string, string>, value: number): void {
        const key = seriesKey(name, labels);
        let h = this.histograms.get(key);
        if (!h) {
            h = { meta: { name, labels }, counts: new Array(HIST_BUCKETS.length).fill(0), sum: 0, count: 0 };
            this.histograms.set(key, h);
        }
        h.sum += value;
        h.count += 1;
        for (let i = 0; i < HIST_BUCKETS.length; i++) {
            if (value <= HIST_BUCKETS[i]!) h.counts[i]! += 1;
        }
    }

    render(): string {
        const lines: string[] = [];
        const emittedHeaders = new Set<string>();
        const ensureHeader = (name: string) => {
            if (emittedHeaders.has(name)) return;
            emittedHeaders.add(name);
            const info = this.helps.get(name);
            if (info) {
                lines.push(`# HELP ${name} ${info.help}`);
                lines.push(`# TYPE ${name} ${info.type}`);
            }
        };

        for (const { meta, value } of this.counters.values()) {
            ensureHeader(meta.name);
            lines.push(`${meta.name}${formatLabels(meta.labels)} ${value}`);
        }
        for (const { meta, value } of this.gauges.values()) {
            ensureHeader(meta.name);
            lines.push(`${meta.name}${formatLabels(meta.labels)} ${value}`);
        }
        for (const { meta, counts, sum, count } of this.histograms.values()) {
            ensureHeader(meta.name);
            for (let i = 0; i < HIST_BUCKETS.length; i++) {
                lines.push(
                    `${meta.name}_bucket${formatLabels({ ...meta.labels, le: String(HIST_BUCKETS[i]!) })} ${counts[i]!}`
                );
            }
            lines.push(`${meta.name}_bucket${formatLabels({ ...meta.labels, le: '+Inf' })} ${count}`);
            lines.push(`${meta.name}_sum${formatLabels(meta.labels)} ${sum}`);
            lines.push(`${meta.name}_count${formatLabels(meta.labels)} ${count}`);
        }
        return lines.join('\n') + '\n';
    }
}

export const metrics = new MetricsRegistry();

metrics.register('http_requests_total', 'counter', 'Total HTTP requests processed');
metrics.register('http_request_duration_seconds', 'histogram', 'HTTP request latency in seconds');
metrics.register('aggregator_leader_epoch', 'gauge', 'Current monotonic fencing epoch per source');
metrics.register('aggregator_is_leader', 'gauge', '1 if this pod holds leadership for the source');
metrics.register('aggregator_poll_total', 'counter', 'Total source polls by outcome');
metrics.register('aggregator_poll_duration_seconds', 'histogram', 'Source poll duration in seconds');
metrics.register('aggregator_inbox_messages_total', 'counter', 'Raw inbox state transitions');
metrics.register('aggregator_inbox_unprocessed', 'gauge', 'Current unprocessed inbox count by status');
metrics.register('aggregator_outbox_pending', 'gauge', 'Pending field-report outbox entries');
metrics.register('satellite_ingest_to_store_seconds', 'histogram', 'Seconds from a satellite frame being stored in the feed log to its HazardEvent being stored');
metrics.register('satellite_processing_backlog', 'gauge', 'Frames in the feed log not yet committed by the processor');
metrics.register('satellite_committed_offset', 'gauge', 'Highest feed offset whose effects are durable');
metrics.register('satellite_log_tail_offset', 'gauge', 'Highest feed offset durably stored in the feed log');
metrics.register('satellite_active_fires', 'gauge', 'Fires currently tracked in processor memory');
metrics.register('satellite_singleton_detections', 'gauge', 'Detections not part of any fire');
metrics.register('satellite_late_detections', 'gauge', 'Detections arriving beyond the allowed lateness');
metrics.register('satellite_watermark_seconds', 'gauge', 'Event-time watermark in epoch seconds');
metrics.register('satellite_source_latest_offset', 'gauge', 'Newest offset the feed reports in /v1/session');
metrics.register('satellite_source_offset_lag', 'gauge', 'Feed offsets not yet stored in the feed log (source offset minus log tail)');
metrics.register('satellite_virtual_now_seconds', 'gauge', 'Feed virtual clock in epoch seconds');
metrics.register('satellite_feed_speed', 'gauge', 'Playback speed of the feed session');
metrics.register('satellite_session_poll_failures_total', 'counter', 'Failed /v1/session polls');
metrics.register('satellite_batch_retries_total', 'counter', 'Processor batches retried after a transient failure');
metrics.register('aggregator_storage_unavailable_total', 'counter', 'Storage unavailable outcomes');

// ---- Lightweight W3C TraceContext + OTLP/HTTP JSON Exporter --------------------------------------

export interface SpanContext {
    traceId: string;
    spanId: string;
    traceparent: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

export function parseTraceparent(header: string | undefined): { traceId: string; parentSpanId: string } | undefined {
    if (!header) return undefined;
    const m = TRACEPARENT_RE.exec(header.trim());
    if (!m) return undefined;
    return { traceId: m[1]!.toLowerCase(), parentSpanId: m[2]!.toLowerCase() };
}

export function newSpanContext(incomingHeader?: string): SpanContext & { parentSpanId?: string } {
    const parsed = parseTraceparent(incomingHeader);
    const traceId = parsed?.traceId ?? randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    return {
        traceId,
        spanId,
        ...(parsed ? { parentSpanId: parsed.parentSpanId } : {}),
        traceparent: `00-${traceId}-${spanId}-01`,
    };
}

interface PendingSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string | undefined;
    name: string;
    kind: number; // 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    statusCode: number; // 1=OK, 2=ERROR
    attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}

const SERVICE_NAME = process.env.SERVICE_NAME || 'aggregator';
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/$/, '');
const spanBuffer: PendingSpan[] = [];
let flushScheduled = false;
let exportInFlight = false;
let exportPausedUntilMs = 0;
const EXPORT_PAUSE_MS = 30_000;

function toAttrs(attrs: Record<string, string | number | undefined>) {
    const out: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> = [];
    for (const [key, v] of Object.entries(attrs)) {
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isInteger(v)) {
            out.push({ key, value: { intValue: String(v) } });
        } else {
            out.push({ key, value: { stringValue: String(v) } });
        }
    }
    return out;
}

async function flushSpans(): Promise<void> {
    flushScheduled = false;
    if (!OTLP_ENDPOINT || spanBuffer.length === 0) {
        spanBuffer.length = 0;
        return;
    }
    const batch = spanBuffer.splice(0, 200);
    // One export at a time, and a pause after a failure: a collector that cannot be resolved or reached must not keep
    // lookups and sockets busy (a failing DNS lookup holds one of the 4 libuv threads for ~1 s, starving every other lookup).
    if (exportInFlight || Date.now() < exportPausedUntilMs) return;
    const payload = {
        resourceSpans: [
            {
                resource: {
                    attributes: toAttrs({
                        'service.name': SERVICE_NAME,
                        'k8s.pod.name': process.env.POD_NAME || process.env.HOSTNAME,
                        'k8s.node.name': process.env.NODE_NAME,
                    }),
                },
                scopeSpans: [
                    {
                        scope: { name: 'bnpb-otel' },
                        spans: batch.map((s) => ({
                            traceId: s.traceId,
                            spanId: s.spanId,
                            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                            name: s.name,
                            kind: s.kind,
                            startTimeUnixNano: s.startTimeUnixNano,
                            endTimeUnixNano: s.endTimeUnixNano,
                            attributes: s.attributes,
                            status: { code: s.statusCode },
                        })),
                    },
                ],
            },
        ],
    };

    exportInFlight = true;
    try {
        await fetch(`${OTLP_ENDPOINT}/v1/traces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(1500),
        });
    } catch {
        // Telemetry must never degrade or fail application traffic
        exportPausedUntilMs = Date.now() + EXPORT_PAUSE_MS;
    } finally {
        exportInFlight = false;
    }
}

export function emitSpan(input: {
    traceId: string;
    spanId: string;
    parentSpanId?: string | undefined;
    name: string;
    kind?: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
    startMs: number;
    endMs: number;
    ok: boolean;
    attributes?: Record<string, string | number | undefined>;
}): void {
    if (!OTLP_ENDPOINT) return;
    const kindMap = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;
    if (spanBuffer.length >= 1000) spanBuffer.shift();
    spanBuffer.push({
        traceId: input.traceId,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        name: input.name,
        kind: kindMap[input.kind ?? 'INTERNAL'],
        startTimeUnixNano: `${Math.trunc(input.startMs)}000000`,
        endTimeUnixNano: `${Math.trunc(input.endMs)}000000`,
        statusCode: input.ok ? 1 : 2,
        attributes: toAttrs(input.attributes ?? {}),
    });
    if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(() => void flushSpans(), 500).unref();
    }
}

export function metricsAndTracingMiddleware(serviceName: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (req.path === '/metrics') {
            next();
            return;
        }
        const ctx = newSpanContext(req.header('traceparent'));
        res.locals.traceId = ctx.traceId;
        res.locals.spanId = ctx.spanId;
        res.locals.traceparent = ctx.traceparent;
        res.setHeader('traceparent', ctx.traceparent);

        const wallStart = Date.now();
        const monoStart = performance.now();

        res.on('finish', () => {
            const durationSec = (performance.now() - monoStart) / 1000;
            const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
            metrics.inc('http_requests_total', {
                service: serviceName,
                method: req.method,
                route,
                status: String(res.statusCode),
            });
            metrics.observe('http_request_duration_seconds', { service: serviceName, route }, durationSec);

            if (req.path !== '/health') {
                emitSpan({
                    traceId: ctx.traceId,
                    spanId: ctx.spanId,
                    parentSpanId: ctx.parentSpanId,
                    name: `${req.method} ${route}`,
                    kind: 'SERVER',
                    startMs: wallStart,
                    endMs: wallStart + durationSec * 1000,
                    ok: res.statusCode < 500,
                    attributes: {
                        'http.method': req.method,
                        'http.route': route,
                        'http.status_code': res.statusCode,
                        'x-correlation-id': String(res.getHeader('x-correlation-id') ?? ''),
                    },
                });
            }
        });
        next();
    };
}

export function metricsEndpoint(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.render());
}
