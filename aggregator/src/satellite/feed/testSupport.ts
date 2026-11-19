import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { InMemoryFeedLog } from './log.js';

export const silent = pino({ level: 'silent' });

export const enc = new TextEncoder();

export function detectionData(offset: number, over: Record<string, unknown> = {}, latText = '5.01297'): string {
    const base = { version: '2.0NRT', acq_date: '2026-12-07', acq_time: 15, confidence: 'n', frp: 3.5, satellite: 'N20', ...over };
    const body = JSON.stringify(base).slice(0, -1);
    return `{"offset":${offset},"detection":${body},"latitude":${latText},"longitude":96.99091}}`;
}

export function sseBlock(offset: number, event: string, data: string): string {
    return `id: ${offset}\nevent: ${event}\ndata: ${data}\n\n`;
}

export interface FakeFeed {
    server: Server;
    url: string;
    requests: Array<{ from: number; auth: string | undefined }>;
    close(): Promise<void>;
}

export type Script = (res: ServerResponse, from: number, attempt: number) => void | Promise<void>;

export async function startFeed(script: Script): Promise<FakeFeed> {
    const requests: FakeFeed['requests'] = [];
    let attempt = 0;
    const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        const from = Number(u.searchParams.get('from'));
        requests.push({ from, auth: req.headers.authorization });
        attempt += 1;
        void script(res, from, attempt);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return {
        server,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
}

export function sseHead(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('condition not met in time');
}

export async function offsets(log: InMemoryFeedLog): Promise<number[]> {
    return (await log.read(0, 10_000)).map((e) => e.offset);
}

export function range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
}
