import express, { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger, requestLogger } from './logger';

const app = express();
app.use(requestLogger);
app.use(express.json());

const PORT = process.env.PVMBG_PORT || 8082;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const TOKEN_SHA256 = process.env.PVMBG_TOKEN_SHA256;
if (!TOKEN_SHA256 || !SHA256_HEX.test(TOKEN_SHA256)) {
    logger.fatal('PVMBG_TOKEN_SHA256 must be set to the SHA-256 hash (64 hex chars) of the PVMBG token');
    process.exit(1);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const TOKEN_DIGEST = Buffer.from(TOKEN_SHA256, 'hex');

let isOutage = false;
let useNewSchema = false;

const REPORT_INTERVAL_MS = parseInt(process.env.PVMBG_REPORT_INTERVAL_MS || '10000', 10);
const DELAY_MIN_MS = parseInt(process.env.PVMBG_DELAY_MIN_MS || '500', 10);
const DELAY_MAX_MS = parseInt(process.env.PVMBG_DELAY_MAX_MS || '3000', 10);
const RUN_ID = Date.now().toString(36);

function createVolcanicReport(n: number, reportedAt: Date) {
    return {
        report_id: `REP-VOLC-${RUN_ID}-${n}`,
        volcano_id: `VOLC-0${(n % 5) + 1}`,
        alert_level: ['Normal', 'Waspada', 'Siaga', 'Awas'][Math.floor(Math.random() * 4)],
        eruption_count_24h: Math.floor(Math.random() * 10),
        ash_column_height_m: +(Math.random() * 5000).toFixed(1),
        reported_at: reportedAt.toISOString(),
    };
}

const volcanicReports = Array.from({ length: 20 }).map((_, i) =>
    createVolcanicReport(i, new Date(Date.now() - i * 3600000))
);

let nextReportNumber = volcanicReports.length;
setInterval(() => {
    volcanicReports.push(createVolcanicReport(nextReportNumber++, new Date()));
}, REPORT_INTERVAL_MS);

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();
    
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (bearer === undefined) {
        return res.status(401).json({ error: 'Authorization header: Bearer <pvmbg-token> is required' });
    }
    if (!timingSafeEqual(sha256(bearer), TOKEN_DIGEST)) {
        res.locals.log.warn('credential rejected');
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (isOutage && !req.path.startsWith('/admin')) {
        return res.status(503).json({ error: 'Service Unavailable (Outage)' });
    }
    
    if (!req.path.startsWith('/admin')) {
        const delay = DELAY_MIN_MS + Math.floor(Math.random() * (Math.max(DELAY_MAX_MS - DELAY_MIN_MS, 0) + 1));
        setTimeout(next, delay);
    } else {
        next();
    }
});

app.get('/health', (req: Request, res: Response) => res.status(200).json({ status: 'ok', service: 'mock-pvmbg' }));

app.get('/volcanic-reports', (req: Request, res: Response) => {
    const since = req.query.since ? new Date(req.query.since as string) : new Date(0);
    const filtered = volcanicReports.filter(rep => new Date(rep.reported_at) >= since);
    
    const responseData = filtered.map(rep => {
        if (useNewSchema) {
            return { ...rep, confidence_level: +(Math.random() * 0.5 + 0.5).toFixed(2) };
        }
        return rep;
    });
    
    res.json(responseData);
});

app.post('/admin/schema-version', (req, res) => {
    useNewSchema = !useNewSchema;
    res.locals.log.info({ confidence_level_enabled: useNewSchema }, 'schema version toggled');
    res.json({ message: `New schema (confidence_level) set to: ${useNewSchema}` });
});

app.post('/admin/outage', (req, res) => {
    isOutage = !isOutage;
    res.locals.log.warn({ outage: isOutage }, 'outage toggled');
    res.json({ message: `Current PVMBG outage status: ${isOutage}` });
});

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'Mock PVMBG started'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info({ signal }, 'mock-pvmbg shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8000).unref();
    });
}