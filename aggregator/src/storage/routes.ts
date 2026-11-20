import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { analyticsPageHtml } from './analyticsPage.js';
import { InvalidCursorError, SOURCES, type Bucket, type ICanonicalRepository, type Source } from './types.js';

// Appendix A (Audit API) + P1 analytics. Mounted by the aggregator with one line:
//   app.use(createStorageRouter({ repo, auditToken: process.env.AUDIT_TOKEN, unprocessed }))
// `unprocessed` is Owner B's inbox (P3); until it exists the endpoint answers an empty, valid page.

export interface UnprocessedProvider {
    list(q: { source?: string | undefined; limit: number; cursor?: string | undefined }): Promise<{ items: unknown[]; next_cursor: string | null }>;
}

export interface StorageRouterDeps {
    repo: ICanonicalRepository;
    auditToken: string | undefined;
    unprocessed?: UnprocessedProvider | undefined;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function sha(s: string): Buffer {
    return createHash('sha256').update(s).digest();
}

function fail(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ error: { code, message } });
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseLimit(v: unknown): number | null {
    if (v === undefined) return DEFAULT_LIMIT;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : null;
}

function parseIso(v: unknown): string | undefined | null {
    if (v === undefined) return undefined;
    const s = str(v);
    if (!s || Number.isNaN(new Date(s).getTime())) return null;
    return new Date(s).toISOString();
}

export function createStorageRouter(deps: StorageRouterDeps): Router {
    const r = express.Router();

    // Page only (no data): the token is typed in the browser and sent to the JSON endpoints.
    r.get('/analytics', (_req, res) => {
        res.type('html').send(analyticsPageHtml());
    });

    const auth = (req: Request, res: Response, next: NextFunction): void => {
        if (!deps.auditToken) return fail(res, 503, 'unavailable', 'audit token belum dikonfigurasi');
        const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
        if (!m || !timingSafeEqual(sha(m[1]!), sha(deps.auditToken))) return fail(res, 401, 'unauthorized', 'token tidak valid');
        next();
    };

    const sourceParam = (req: Request, res: Response): Source | undefined | null => {
        const s = str(req.query['source']);
        if (s === undefined) return undefined;
        if (!(SOURCES as readonly string[]).includes(s)) {
            fail(res, 400, 'bad_request', `source harus salah satu dari ${SOURCES.join(', ')}`);
            return null;
        }
        return s as Source;
    };

    r.get('/internal/audit/events', auth, async (req, res) => {
        const source = sourceParam(req, res);
        if (source === null) return;
        const since = parseIso(req.query['since']);
        const limit = parseLimit(req.query['limit']);
        if (since === null) return fail(res, 400, 'bad_request', 'since harus ISO 8601');
        if (limit === null) return fail(res, 400, 'bad_request', 'limit harus bilangan bulat >= 1');
        try {
            const page = await deps.repo.queryGlobal({ sort: 'ingested_asc', limit, filter: { source, since }, cursor: str(req.query['cursor']) });
            res.json({ items: page.items, next_cursor: page.next_cursor, partial: page.partial, unavailable_units: page.unavailable_units });
        } catch (err) {
            if (err instanceof InvalidCursorError) return fail(res, 400, 'bad_request', 'cursor tidak valid');
            fail(res, 503, 'unavailable', 'penyimpanan tidak dapat dijangkau');
        }
    });

    r.get('/internal/audit/checksum', auth, async (req, res) => {
        const source = sourceParam(req, res);
        if (source === null) return;
        try {
            res.json(await deps.repo.checksum(source));
        } catch {
            fail(res, 503, 'unavailable', 'penyimpanan tidak dapat dijangkau');
        }
    });

    r.get('/internal/audit/location', auth, async (req, res) => {
        const id = str(req.query['hazard_id']);
        if (!id) return fail(res, 400, 'bad_request', 'hazard_id wajib');
        try {
            const loc = await deps.repo.locate(id);
            if (!loc) return fail(res, 404, 'not_found', 'hazard_id tidak ditemukan');
            res.json(loc);
        } catch {
            fail(res, 503, 'unavailable', 'penyimpanan tidak dapat dijangkau');
        }
    });

    r.get('/internal/audit/unprocessed', auth, async (req, res) => {
        const source = str(req.query['source']);
        const limit = parseLimit(req.query['limit']);
        if (limit === null) return fail(res, 400, 'bad_request', 'limit harus bilangan bulat >= 1');
        try {
            const page = deps.unprocessed
                ? await deps.unprocessed.list({ source, limit, cursor: str(req.query['cursor']) })
                : { items: [], next_cursor: null };
            res.json(page);
        } catch (err) {
            if (err instanceof InvalidCursorError) return fail(res, 400, 'bad_request', 'cursor tidak valid');
            fail(res, 503, 'unavailable', 'penyimpanan tidak dapat dijangkau');
        }
    });

    r.get('/internal/analytics/summary', auth, async (req, res) => {
        const from = parseIso(req.query['from']);
        const to = parseIso(req.query['to']);
        const bucket = (str(req.query['bucket']) ?? 'day') as Bucket;
        if (from === null || to === null) return fail(res, 400, 'bad_request', 'from/to harus ISO 8601');
        if (!['hour', 'day', 'week'].includes(bucket)) return fail(res, 400, 'bad_request', 'bucket harus hour|day|week');
        try {
            res.json(await deps.repo.aggregate({ from, to, bucket }));
        } catch {
            fail(res, 503, 'unavailable', 'penyimpanan tidak dapat dijangkau');
        }
    });

    r.get('/internal/store/status', auth, async (_req, res) => {
        res.json({ units: await deps.repo.unitStatus() });
    });

    return r;
}
