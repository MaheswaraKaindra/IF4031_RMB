import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config.js';
import { CORRELATION_HEADER } from './middleware/correlationId.js';
import type { HazardEvent, SourceStatuses } from './types.js';

const http = axios.create({
    baseURL: config.aggregatorUrl,
    timeout: config.aggregatorTimeoutMs,
});

export interface RequestContext {
    correlationId: string;
    traceparent?: string | undefined;
    log: Logger;
}

export interface EventsQuery {
    hazard_type?: HazardEvent['hazard_type'] | undefined;
    severity?: HazardEvent['severity'] | undefined;
    limit?: number | undefined;
}

function forwardHeaders(ctx: RequestContext, extra: Record<string, string | undefined> = {}): Record<string, string> {
    const h: Record<string, string> = { [CORRELATION_HEADER]: ctx.correlationId };
    if (ctx.traceparent) h['traceparent'] = ctx.traceparent;
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) h[k] = v;
    }
    return h;
}

async function timedCall<T>(ctx: RequestContext, name: string, call: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
        const result = await call();
        ctx.log.info({ target: 'aggregator', call: name, duration_ms: Math.round(performance.now() - start) }, 'outgoing call ok');
        return result;
    } catch (error) {
        ctx.log.warn(
            {
                target: 'aggregator',
                call: name,
                duration_ms: Math.round(performance.now() - start),
                error: error instanceof Error ? error.message : String(error),
            },
            'outgoing call failed'
        );
        throw error;
    }
}

export interface EventsResult {
    events: HazardEvent[];
    partial: boolean;
    unavailable_units: string[];
}

export function fetchEvents(query: EventsQuery, ctx: RequestContext): Promise<EventsResult> {
    return timedCall(ctx, 'GET /internal/events', async () => {
        const res = await http.get<{ events: HazardEvent[]; partial?: boolean; unavailable_units?: string[] }>('/internal/events', {
            params: query,
            headers: forwardHeaders(ctx),
        });
        return { events: res.data.events, partial: res.data.partial === true, unavailable_units: res.data.unavailable_units ?? [] };
    });
}

export function fetchStatus(ctx: RequestContext): Promise<SourceStatuses> {
    return timedCall(ctx, 'GET /internal/status', async () => {
        const res = await http.get<SourceStatuses>('/internal/status', {
            headers: forwardHeaders(ctx),
        });
        return res.data;
    });
}

export function submitFieldReport(
    body: unknown,
    opts: { clientId: string; idempotencyKey?: string | undefined },
    ctx: RequestContext
): Promise<{ status: number; data: unknown }> {
    return timedCall(ctx, 'POST /internal/field-reports', async () => {
        const res = await http.post('/internal/field-reports', body, {
            headers: forwardHeaders(ctx, {
                'x-client-id': opts.clientId,
                'idempotency-key': opts.idempotencyKey,
            }),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    });
}

export function fetchUnprocessed(
    query: { source?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
    ctx: RequestContext
): Promise<{ status: number; data: unknown }> {
    return timedCall(ctx, 'GET /internal/ops/unprocessed', async () => {
        const res = await http.get('/internal/ops/unprocessed', {
            params: query,
            headers: forwardHeaders(ctx),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    });
}

export function replayUnprocessed(body: unknown, ctx: RequestContext): Promise<{ status: number; data: unknown }> {
    return timedCall(ctx, 'POST /internal/ops/unprocessed/replay', async () => {
        const res = await http.post('/internal/ops/unprocessed/replay', body ?? {}, {
            headers: forwardHeaders(ctx),
            timeout: 15_000,
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    });
}

export function updateSchemaRules(body: unknown, ctx: RequestContext): Promise<{ status: number; data: unknown }> {
    return timedCall(ctx, 'POST /internal/ops/schema-rules', async () => {
        const res = await http.post('/internal/ops/schema-rules', body ?? {}, {
            headers: forwardHeaders(ctx),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    });
}
