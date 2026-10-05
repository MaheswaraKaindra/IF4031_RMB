import { Router } from 'express';
import { fetchEvents, fetchStatus, type RequestContext } from '../aggregatorClient.js';
import { ALL_FIELDS, defaultFields, forbiddenFields, project } from '../fieldAccess.js';
import { buildSources } from '../freshness.js';
import { getScope } from '../middleware/auth.js';
import { getCorrelationId, getLog } from '../middleware/correlationId.js';
import { HAZARD_TYPES, SEVERITIES, parseEnum, parseFields, parseLimit } from '../validation.js';

export const eventsRouter = Router();

eventsRouter.get('/', async (req, res) => {
    const hazard_type = parseEnum(req.query.hazard_type, HAZARD_TYPES);
    const severity = parseEnum(req.query.severity, SEVERITIES);
    const limit = parseLimit(req.query.limit, 50);
    const requestedFields = parseFields(req.query.fields, ALL_FIELDS);
    if (hazard_type === null || severity === null || limit === null || requestedFields === null) {
        res.status(400).json({ error: 'hazard_type, severity, limit, or fields is invalid' });
        return;
    }

    const scope = getScope(res);
    const denied = forbiddenFields(scope, requestedFields ?? []);
    if (denied.length > 0) {
        getLog(res).warn({ scope, denied_fields: denied }, 'raw field request denied');
        res.status(403).json({
            error: 'insufficient_scope',
            error_description: `Scope ${scope} is not authorized to access fields: ${denied.join(', ')}`,
        });
        return;
    }
    const fields = requestedFields ?? defaultFields(scope);

    const ctx: RequestContext = { correlationId: getCorrelationId(res), log: getLog(res) };

    const [eventsResult, statusResult] = await Promise.allSettled([
        fetchEvents({ hazard_type, severity, limit }, ctx),
        fetchStatus(ctx),
    ]);

    if (eventsResult.status === 'rejected') {
        res.status(503).json({
            error: 'Data is not yet available, please try again shortly',
            correlation_id: ctx.correlationId,
        });
        return;
    }

    const sources = statusResult.status === 'fulfilled' ? buildSources(statusResult.value) : null;

    res.json({ events: eventsResult.value.map((event) => project(event, fields)), sources });
});
