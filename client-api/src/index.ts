import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { auth } from './middleware/auth.js';
import { correlationId, getLog } from './middleware/correlationId.js';
import { inFlightLimit } from './middleware/inFlightLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { eventsRouter } from './routes/events.js';

const app = express();
app.disable('x-powered-by');

app.use(correlationId);
app.use(requestLogger);
app.use(inFlightLimit(config.maxInFlight));

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'client-api' });
});

app.use('/events', auth, eventsRouter);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Tidak ditemukan' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    getLog(res).error({ error: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
});

const server = app.listen(config.port, () => {
    logger.info({ port: config.port, aggregator_url: config.aggregatorUrl }, 'client-api berjalan');
});

// Graceful shutdown: docker stop mengirim SIGTERM dan request yang berjalan dibiarkan selesai
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'client-api berhenti');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}
