import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import type { Client } from './clients.js';
import { config } from './config.js';

const privateKey = await importPKCS8(config.jwtPrivateKeyPem, 'RS256');

export interface AccessToken {
    token: string;
    jti: string;
}

export async function signAccessToken(client: Client): Promise<AccessToken> {
    const jti = randomUUID();
    const token = await new SignJWT({ scope: client.scope })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(config.jwtIssuer)
        .setAudience(config.jwtAudience)
        .setSubject(client.id)
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
        .sign(privateKey);
    return { token, jti };
}
