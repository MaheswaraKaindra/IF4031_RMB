import type { NextFunction, Request, Response } from 'express';

// PLACEHOLDER untuk verifikasi JWT dari "Authorization: Bearer <token>"
export function auth(_req: Request, _res: Response, next: NextFunction): void {
    next();
}
