import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { correlationId, getLog } from './middleware/correlationId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { tokenRouter } from './routes/token.js';

const app = express();
app.disable('x-powered-by');

app.use(correlationId);
app.use(requestLogger);
app.use(express.json({ limit: '4kb' }));

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'auth-service' });
});

app.use(tokenRouter);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'invalid_request', error_description: 'Body must be valid JSON' });
        return;
    }
    getLog(res).error({ error: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
    logger.info(
        { port: config.port, access_token_ttl_s: config.accessTokenTtlSeconds, refresh_token_ttl_s: config.refreshTokenTtlSeconds },
        'auth-service started'
    );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'auth-service stopped');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}
