import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { auth } from './middleware/auth.js';
import { correlationId, getLog } from './middleware/correlationId.js';
import { PriorityAdmission, priorityAdmission } from './middleware/admission.js';
import { inFlightLimit } from './middleware/inFlightLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { incCounter, observabilityMiddleware, renderMetrics } from './observability.js';
import { eventsRouter } from './routes/events.js';
import { fieldReportsRouter } from './routes/fieldReports.js';
import { unprocessedRouter } from './routes/unprocessed.js';

const app = express();
app.disable('x-powered-by');
let shuttingDown = false;

app.use(observabilityMiddleware('client-api'));
app.use(correlationId);
app.use(requestLogger);
// Pre-auth safety valve only. The per-class partition below decides who is served under overload.
app.use(inFlightLimit(config.hardCapInFlight));
const admission = new PriorityAdmission({ total: config.maxInFlight, reservedFieldTeam: config.reservedFieldTeam, mediaMax: config.mediaMaxInFlight });
const admit = priorityAdmission(admission, {
    onAdmit: (cls) => incCounter('client_api_admission_total', { client_class: cls, outcome: 'admitted' }),
    onReject: (cls) => incCounter('client_api_admission_total', { client_class: cls, outcome: 'rejected' }),
});

app.get('/metrics', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
});

app.get('/health', (_req: Request, res: Response) => {
    if (shuttingDown) {
        res.status(503).json({ status: 'draining', service: 'client-api' });
        return;
    }
    res.status(200).json({ status: 'ok', service: 'client-api' });
});

app.use('/events', auth, admit, eventsRouter);
app.use('/field-reports', express.json({ limit: '256kb' }), auth, admit, fieldReportsRouter);
app.use('/unprocessed', express.json({ limit: '64kb' }), auth, admit, unprocessedRouter);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    getLog(res).error({ error: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
    logger.info({ port: config.port, aggregator_url: config.aggregatorUrl }, 'client-api started');
});

// Graceful shutdown: return 503 on /health immediately, allow in-flight requests to finish cleanly
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        shuttingDown = true;
        logger.info({ signal }, 'client-api draining');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
    });
}
