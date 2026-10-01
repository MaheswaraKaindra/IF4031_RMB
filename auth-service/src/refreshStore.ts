import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';

interface RefreshEntry {
    clientId: string;
    family: string;
    expiresAt: number;
    used: boolean;
}

export type RotateResult =
    | { ok: true; clientId: string; family: string }
    | { ok: false; reason: 'unknown' | 'expired' | 'reused'; clientId?: string };

// Disimpan berdasarkan hash, sehingga isi store tidak bisa dipakai langsung sebagai refresh token
const entries = new Map<string, RefreshEntry>();

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function issueRefreshToken(clientId: string, family: string = randomUUID()): string {
    const token = randomBytes(32).toString('base64url');
    entries.set(hash(token), {
        clientId,
        family,
        expiresAt: Date.now() + config.refreshTokenTtlSeconds * 1000,
        used: false,
    });
    return token;
}

function revokeFamily(family: string): void {
    for (const [key, entry] of entries) {
        if (entry.family === family) entries.delete(key);
    }
}

export function consumeRefreshToken(token: string): RotateResult {
    const entry = entries.get(hash(token));
    if (entry === undefined) return { ok: false, reason: 'unknown' };

    if (entry.used) {
        revokeFamily(entry.family);
        return { ok: false, reason: 'reused', clientId: entry.clientId };
    }
    if (entry.expiresAt <= Date.now()) {
        revokeFamily(entry.family);
        return { ok: false, reason: 'expired', clientId: entry.clientId };
    }

    entry.used = true;
    return { ok: true, clientId: entry.clientId, family: entry.family };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
    }
}, 60_000).unref();
