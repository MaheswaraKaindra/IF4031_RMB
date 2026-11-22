export type SensorErrorKind = 'timeout' | 'network' | 'http' | 'too_large' | 'not_json';

export class SensorRequestError extends Error {
    constructor(
        readonly kind: SensorErrorKind,
        message: string,
        readonly status?: number,
        readonly raw?: Buffer,
    ) {
        super(message);
    }
}

export interface ObservationQuery {
    cursor?: string | undefined;
    limit: number;
}

export interface SensorClient {
    stations(): Promise<unknown>;
    observations(q: ObservationQuery): Promise<unknown>;
}

export interface HttpSensorOptions {
    baseUrl: string;
    token: string;
    timeoutMs: number;
    maxBytes: number;
    fetchImpl?: typeof fetch;
}

export class HttpSensorClient implements SensorClient {
    constructor(private readonly o: HttpSensorOptions) {}

    stations(): Promise<unknown> {
        return this.get('/v1/stations');
    }

    observations(q: ObservationQuery): Promise<unknown> {
        const params = new URLSearchParams({ limit: String(q.limit) });
        if (q.cursor) params.set('cursor', q.cursor);
        return this.get(`/v1/observations?${params.toString()}`);
    }

    // One attempt, one deadline covering connect, headers and body. Retrying is the poll loop's job (single retry budget).
    private async get(path: string): Promise<unknown> {
        const doFetch = this.o.fetchImpl ?? fetch;
        let res: Response;
        let body: Buffer;
        try {
            res = await doFetch(`${this.o.baseUrl}${path}`, {
                headers: { Authorization: `Bearer ${this.o.token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(this.o.timeoutMs),
            });
            body = await readCapped(res, this.o.maxBytes);
        } catch (err) {
            if (err instanceof SensorRequestError) throw err;
            const name = (err as { name?: string }).name;
            if (name === 'TimeoutError' || name === 'AbortError') throw new SensorRequestError('timeout', `timeout after ${this.o.timeoutMs} ms`);
            throw new SensorRequestError('network', err instanceof Error ? err.message : String(err));
        }
        if (res.status < 200 || res.status >= 300) throw new SensorRequestError('http', `HTTP ${res.status}`, res.status);
        try {
            return JSON.parse(body.toString('utf8'));
        } catch {
            throw new SensorRequestError('not_json', 'response body is not JSON', res.status, body);
        }
    }
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new SensorRequestError('too_large', `response exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}
