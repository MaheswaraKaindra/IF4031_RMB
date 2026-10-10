import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'mock-pvmbg' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
});

const CORRELATION_HEADER = 'x-correlation-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const id = incoming !== undefined && VALID_ID.test(incoming) ? incoming : randomUUID();
    const log = logger.child({ correlation_id: id });
    const start = performance.now();

    res.locals.log = log;
    res.setHeader(CORRELATION_HEADER, id);
    res.on('finish', () => {
        const entry = {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration_ms: Math.round(performance.now() - start),
        };
        if (req.path === '/health') log.debug(entry, 'request');
        else log.info(entry, 'request');
    });
    next();
}
