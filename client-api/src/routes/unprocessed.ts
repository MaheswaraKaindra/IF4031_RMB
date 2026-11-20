import { Router } from 'express';
import { fetchUnprocessed, replayUnprocessed, updateSchemaRules, type RequestContext } from '../aggregatorClient.js';
import { getCorrelationId, getLog } from '../middleware/correlationId.js';

export const unprocessedRouter = Router();

function ensureInternalOps(res: import('express').Response): boolean {
    const clientId = String(res.locals.clientId ?? '');
    if (clientId !== 'bnpb-ops') {
        getLog(res).warn({ client_id: clientId }, 'non-ops access to failed messages denied');
        res.status(403).json({
            error: 'insufficient_scope',
            error_description: 'Failed messages may only be inspected or replayed by BNPB Internal Ops',
        });
        return false;
    }
    return true;
}

function buildCtx(res: import('express').Response): RequestContext {
    return {
        correlationId: getCorrelationId(res),
        traceparent: typeof res.locals.traceparent === 'string' ? res.locals.traceparent : undefined,
        log: getLog(res),
    };
}

unprocessedRouter.get('/', async (req, res) => {
    if (!ensureInternalOps(res)) return;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 1000' });
        return;
    }
    try {
        const result = await fetchUnprocessed({ source, limit, cursor }, buildCtx(res));
        res.status(result.status).json(result.data);
    } catch {
        res.status(503).json({ error: 'Aggregator unavailable' });
    }
});

unprocessedRouter.post('/replay', async (req, res) => {
    if (!ensureInternalOps(res)) return;
    try {
        const result = await replayUnprocessed(req.body, buildCtx(res));
        res.status(result.status).json(result.data);
    } catch {
        res.status(503).json({ error: 'Aggregator unavailable' });
    }
});

unprocessedRouter.post('/schema-rules', async (req, res) => {
    if (!ensureInternalOps(res)) return;
    try {
        const result = await updateSchemaRules(req.body, buildCtx(res));
        res.status(result.status).json(result.data);
    } catch {
        res.status(503).json({ error: 'Aggregator unavailable' });
    }
});
