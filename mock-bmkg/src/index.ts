// App's Entry Point

import express, { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger, requestLogger } from './logger';

const app = express();
app.use(requestLogger);
const PORT = process.env.BMKG_PORT || 8081;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const API_KEY_SHA256 = process.env.X_BMKG_KEY_SHA256;
if (!API_KEY_SHA256 || !SHA256_HEX.test(API_KEY_SHA256)) {
    logger.fatal('X_BMKG_KEY_SHA256 must be set with the SHA-256 hash (64 hex) of the BMKG API key');
    process.exit(1);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const API_KEY_DIGEST = Buffer.from(API_KEY_SHA256, 'hex');

const EVENT_INTERVAL_MS = parseInt(process.env.BMKG_EVENT_INTERVAL_MS || '10000', 10); // new event every 10s (spec minimum)

function createSeismicEvent(n: number, occurredAt: Date) {
    return {
        event_id: `EV-BMKG-${1000 + n}`,
        magnitude: +(Math.random() * (7.5 - 3.0) + 3.0).toFixed(1),
        depth_km: +(Math.random() * 50 + 10).toFixed(1),
        epicenter_lat: -8.5 + Math.random(),
        epicenter_lon: 110.0 + Math.random(),
        region_name: `Coastal Region ${n}`,
        occurred_at: occurredAt.toISOString(),
        potential_tsunami: n % 5 === 0
    };
}

function createTsunamiWarning(ev: ReturnType<typeof createSeismicEvent>, issuedAt?: Date) {
    return {
        warning_id: `WARN-${ev.event_id}`,
        related_event_id: ev.event_id,
        threat_level: ev.magnitude >= 6.5 ? 'AWAS' : (ev.magnitude >= 5.0 ? 'SIAGA' : 'WASPADA'),
        affected_zones: [ev.region_name, 'Surrounding Coast'],
        estimated_arrival: new Date(new Date(ev.occurred_at).getTime() + 1800000).toISOString(),
        issued_at: (issuedAt ?? new Date(ev.occurred_at)).toISOString()
    };
}

const seismicEvents = Array.from({ length: 20 }).map((_, i) =>
    createSeismicEvent(i, new Date(Date.now() - i * 3600000))
);

const tsunamiWarnings = seismicEvents
    .filter(ev => ev.potential_tsunami)
    .map(ev => createTsunamiWarning(ev, new Date(ev.occurred_at)));

let nextEventNumber = seismicEvents.length;
setInterval(() => {
    const now = new Date();
    const ev = createSeismicEvent(nextEventNumber++, now);
    seismicEvents.push(ev);
    if (ev.potential_tsunami) tsunamiWarnings.push(createTsunamiWarning(ev, now));
}, EVENT_INTERVAL_MS);

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();

    const key = req.headers['x-bmkg-key'];
    if (typeof key !== 'string') {
        return res.status(401).json({ error: 'X-BMKG-Key header is required' });
    }
    if (!timingSafeEqual(sha256(key), API_KEY_DIGEST)) {
        res.locals.log.warn('credential rejected');
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const delay = Math.floor(Math.random() * 100) + 50; // 50-150 ms
    setTimeout(next, delay);
});

app.get('/health', (req: Request, res: Response) => res.status(200).json({ status: 'ok', service: 'mock-bmkg' }));

app.get('/seismic-events', (req: Request, res: Response) => {
    const since = req.query.since ? new Date(req.query.since as string) : new Date(0);
    const filtered = seismicEvents.filter(ev => new Date(ev.occurred_at) >= since);
    res.json(filtered);
});

app.get('/tsunami-warnings', (req: Request, res: Response) => {
    const sinceRaw = req.query.since;
    const since = sinceRaw ? new Date(sinceRaw as string) : new Date(0);
    const filtered = tsunamiWarnings.filter(w => new Date(w.issued_at) >= since);
    res.json(filtered);
});

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'Mock BMKG running'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'mock-bmkg stopped');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}