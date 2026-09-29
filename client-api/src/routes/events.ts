import { Router } from 'express';
import { fetchEvents, fetchStatus, type RequestContext } from '../aggregatorClient.js';
import { buildSources } from '../freshness.js';
import { getCorrelationId, getLog } from '../middleware/correlationId.js';
import { HAZARD_TYPES, SEVERITIES, parseEnum, parseLimit } from '../validation.js';

export const eventsRouter = Router();

eventsRouter.get('/', async (req, res) => {
    const hazard_type = parseEnum(req.query.hazard_type, HAZARD_TYPES);
    const severity = parseEnum(req.query.severity, SEVERITIES);
    const limit = parseLimit(req.query.limit, 50);
    if (hazard_type === null || severity === null || limit === null) {
        res.status(400).json({ error: 'hazard_type, severity, atau limit tidak valid' });
        return;
    }

    const ctx: RequestContext = { correlationId: getCorrelationId(res), log: getLog(res) };

    const [eventsResult, statusResult] = await Promise.allSettled([
        fetchEvents({ hazard_type, severity, limit }, ctx),
        fetchStatus(ctx),
    ]);

    if (eventsResult.status === 'rejected') {
        res.status(503).json({
            error: 'Data belum tersedia, coba lagi sebentar',
            correlation_id: ctx.correlationId,
        });
        return;
    }

    const sources = statusResult.status === 'fulfilled' ? buildSources(statusResult.value) : null;

    res.json({ events: eventsResult.value, sources });
});
