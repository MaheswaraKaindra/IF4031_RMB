import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getLog } from './correlationId.js';

const failures = new Map<string, number[]>();
const windowMs = config.failureWindowSeconds * 1000;

function recent(address: string, now: number): number[] {
    const kept = (failures.get(address) ?? []).filter((at) => now - at < windowMs);
    if (kept.length === 0) failures.delete(address);
    else failures.set(address, kept);
    return kept;
}

export function recordFailure(address: string | undefined): void {
    const key = address ?? 'unknown';
    const now = Date.now();
    failures.set(key, [...recent(key, now), now]);
}

export function throttleFailures(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const attempts = recent(req.ip ?? 'unknown', now);
    if (attempts.length < config.maxFailedAttempts) {
        next();
        return;
    }
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - (attempts[0] ?? now))) / 1000));
    getLog(res).warn({ address: req.ip, failed_attempts: attempts.length }, 'too many failed attempts, request throttled');
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'too_many_attempts', error_description: 'Too many failed attempts, try again later' });
}

setInterval(() => {
    const now = Date.now();
    for (const address of failures.keys()) recent(address, now);
}, 60_000).unref();
