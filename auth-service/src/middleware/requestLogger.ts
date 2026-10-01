import type { NextFunction, Request, Response } from 'express';
import { getLog } from './correlationId.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const start = performance.now();
    const path = req.path;

    res.on('finish', () => {
        const entry = {
            method: req.method,
            path,
            status: res.statusCode,
            duration_ms: Math.round(performance.now() - start),
        };
        if (path === '/health') getLog(res).debug(entry, 'request');
        else getLog(res).info(entry, 'request');
    });

    next();
}
