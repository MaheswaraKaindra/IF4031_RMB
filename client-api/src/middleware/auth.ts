import type { NextFunction, Request, Response } from 'express';
import { errors, importSPKI, jwtVerify } from 'jose';
import { config } from '../config.js';
import type { Scope } from '../types.js';
import { getLog } from './correlationId.js';

const publicKey = await importSPKI(config.jwtPublicKeyPem, 'RS256');

const SCOPES: readonly Scope[] = ['events:read:summary', 'events:read:raw'];

function reject(res: Response, status: 401 | 403, error: string, description: string): void {
    if (status === 401) {
        res.setHeader('WWW-Authenticate', `Bearer error="${error}", error_description="${description}"`);
    }
    res.status(status).json({ error, error_description: description });
}

export async function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header('authorization');
    if (header === undefined || !header.startsWith('Bearer ')) {
        reject(res, 401, 'invalid_token', 'Authorization header: Bearer <token> is required');
        return;
    }

    try {
        const { payload } = await jwtVerify(header.slice('Bearer '.length), publicKey, {
            algorithms: ['RS256'],
            issuer: config.jwtIssuer,
            audience: config.jwtAudience,
            requiredClaims: ['sub', 'exp', 'scope'],
        });

        if (!SCOPES.includes(payload.scope as Scope)) {
            reject(res, 403, 'insufficient_scope', 'Unrecognized token scope');
            return;
        }

        res.locals.clientId = payload.sub;
        res.locals.scope = payload.scope;
        res.locals.log = getLog(res).child({ client_id: payload.sub });
        next();
    } catch (error) {
        if (error instanceof errors.JWTExpired) {
            reject(res, 401, 'token_expired', 'Access token has expired, please refresh');
            return;
        }
        getLog(res).warn({ error: error instanceof Error ? error.message : String(error) }, 'token rejected');
        reject(res, 401, 'invalid_token', 'Invalid access token');
    }
}

export function getScope(res: Response): Scope {
    return res.locals.scope as Scope;
}
