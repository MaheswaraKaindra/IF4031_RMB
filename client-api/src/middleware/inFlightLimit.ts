import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function inFlightLimit(max: number): RequestHandler {
    let inFlight = 0;

    return (req: Request, res: Response, next: NextFunction): void => {
        if (req.path === '/health') {
            next();
            return;
        }

        if (inFlight >= max) {
            res.setHeader('Retry-After', '1');
            res.status(429).json({ error: 'Terlalu banyak permintaan, coba lagi sebentar' });
            return;
        }

        inFlight++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            inFlight--;
        };
        res.on('finish', release);
        res.on('close', release);

        next();
    };
}
