import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export type Scope = 'events:read:summary' | 'events:read:raw';

export interface Client {
    id: string;
    scope: Scope;
}

interface RegisteredClient extends Client {
    secretDigest: Buffer;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

const SCOPES: Record<keyof typeof config.clientSecretHashes, Scope> = {
    media: 'events:read:summary',
    'field-team': 'events:read:raw',
    'bnpb-ops': 'events:read:raw',
};

const hashes = Object.values(config.clientSecretHashes);
if (new Set(hashes).size !== hashes.length) {
    throw new Error('Setiap client wajib memiliki secret yang berbeda');
}

const registry = new Map<string, RegisteredClient>(
    Object.entries(config.clientSecretHashes).map(([id, hash]) => [
        id,
        { id, scope: SCOPES[id as keyof typeof SCOPES], secretDigest: Buffer.from(hash, 'hex') },
    ])
);

// Dibandingkan terhadap digest dummy agar client_id tak dikenal tidak bisa dibedakan lewat waktu respons
const DUMMY_DIGEST = sha256('dummy');

export function authenticateClient(clientId: string, secret: string): Client | undefined {
    const client = registry.get(clientId);
    const matches = timingSafeEqual(sha256(secret), client?.secretDigest ?? DUMMY_DIGEST);
    return client !== undefined && matches ? { id: client.id, scope: client.scope } : undefined;
}

export function findClient(clientId: string): Client | undefined {
    const client = registry.get(clientId);
    return client && { id: client.id, scope: client.scope };
}
