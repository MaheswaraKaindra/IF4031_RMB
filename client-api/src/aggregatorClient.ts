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
    log: Logger;
}

export interface EventsQuery {
    hazard_type?: HazardEvent['hazard_type'] | undefined;
    severity?: HazardEvent['severity'] | undefined;
    limit?: number | undefined;
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

export function fetchEvents(query: EventsQuery, ctx: RequestContext): Promise<HazardEvent[]> {
    return timedCall(ctx, 'GET /internal/events', async () => {
        const res = await http.get<{ events: HazardEvent[] }>('/internal/events', {
            params: query,
            headers: { [CORRELATION_HEADER]: ctx.correlationId },
        });
        return res.data.events;
    });
}

export function fetchStatus(ctx: RequestContext): Promise<SourceStatuses> {
    return timedCall(ctx, 'GET /internal/status', async () => {
        const res = await http.get<SourceStatuses>('/internal/status', {
            headers: { [CORRELATION_HEADER]: ctx.correlationId },
        });
        return res.data;
    });
}
