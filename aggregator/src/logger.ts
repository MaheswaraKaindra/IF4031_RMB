import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino, { type Logger } from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'aggregator' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
});

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

export function getLog(res: Response): Logger {
    return res.locals.log as Logger;
}

export async function timed<T>(log: Logger, target: string, call: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
        const result = await fn();
        log.info({ target, call, duration_ms: Math.round(performance.now() - start) }, 'outgoing call ok');
        return result;
    } catch (error) {
        log.warn(
            { target, call, duration_ms: Math.round(performance.now() - start), error: errorMessage(error) },
            'outgoing call failed'
        );
        throw error;
    }
}
