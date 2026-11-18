import { Router } from 'express';
import { submitFieldReport, type RequestContext } from '../aggregatorClient.js';
import { getCorrelationId, getLog } from '../middleware/correlationId.js';

export const fieldReportsRouter = Router();

const ALLOWED_WRITERS = new Set(['field-team', 'bnpb-ops']);

fieldReportsRouter.post('/', async (req, res) => {
    const clientId = String(res.locals.clientId ?? '');
    if (!ALLOWED_WRITERS.has(clientId)) {
        getLog(res).warn({ client_id: clientId }, 'unauthorized POST /field-reports attempt');
        res.status(403).json({
            error: 'insufficient_scope',
            error_description: 'Only Tim Lapangan or BNPB Internal Ops may submit field reports',
        });
        return;
    }

    const ctx: RequestContext = {
        correlationId: getCorrelationId(res),
        traceparent: typeof res.locals.traceparent === 'string' ? res.locals.traceparent : undefined,
        log: getLog(res),
    };
    const idempotencyKey = req.header('idempotency-key') || undefined;

    try {
        const result = await submitFieldReport(req.body, { clientId, idempotencyKey }, ctx);
        res.status(result.status).json(result.data);
    } catch {
        res.status(503).json({
            error: 'unavailable',
            error_description: 'Aggregator unavailable, field report was not durably accepted',
            correlation_id: ctx.correlationId,
        });
    }
});
