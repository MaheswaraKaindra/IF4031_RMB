import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { auth } from './middleware/auth.js';
import { correlationId, getLog } from './middleware/correlationId.js';
import { inFlightLimit } from './middleware/inFlightLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { observabilityMiddleware, renderMetrics } from './observability.js';
import { eventsRouter } from './routes/events.js';
import { fieldReportsRouter } from './routes/fieldReports.js';
import { unprocessedRouter } from './routes/unprocessed.js';

const app = express();
app.disable('x-powered-by');
let shuttingDown = false;

app.use(observabilityMiddleware('client-api'));
app.use(correlationId);
app.use(requestLogger);
app.use(inFlightLimit(config.maxInFlight));

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

app.use('/events', auth, eventsRouter);
app.use('/field-reports', express.json({ limit: '256kb' }), auth, fieldReportsRouter);
app.use('/unprocessed', express.json({ limit: '64kb' }), auth, unprocessedRouter);

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
