import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { logger } from '../logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function correlationId(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const id = incoming !== undefined && VALID_ID.test(incoming) ? incoming : randomUUID();

    res.locals.correlationId = id;
    res.locals.log = logger.child({ correlation_id: id });
    res.setHeader(CORRELATION_HEADER, id);
    next();
}

export function getCorrelationId(res: Response): string {
    return res.locals.correlationId as string;
}

export function getLog(res: Response): Logger {
    return res.locals.log as Logger;
}
