import { Router, type Response } from 'express';
import { authenticateClient, findClient, type Client } from '../clients.js';
import { config } from '../config.js';
import { getLog } from '../middleware/correlationId.js';
import { consumeRefreshToken, issueRefreshToken } from '../refreshStore.js';
import { signAccessToken } from '../tokens.js';

export const tokenRouter = Router();

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function oauthError(res: Response, status: number, error: string, description: string): void {
    res.status(status).json({ error, error_description: description });
}

async function issueTokens(res: Response, client: Client, family?: string): Promise<void> {
    const access = await signAccessToken(client);
    const refreshToken = issueRefreshToken(client.id, family);

    getLog(res).info({ client_id: client.id, scope: client.scope, jti: access.jti }, 'token issued');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: refreshToken,
        refresh_expires_in: config.refreshTokenTtlSeconds,
        scope: client.scope,
    });
}

tokenRouter.post('/token', async (req, res) => {
    const { client_id, client_secret } = req.body ?? {};
    if (!isNonEmptyString(client_id) || !isNonEmptyString(client_secret)) {
        oauthError(res, 400, 'invalid_request', 'client_id dan client_secret wajib diisi');
        return;
    }

    const client = authenticateClient(client_id, client_secret);
    if (client === undefined) {
        getLog(res).warn({ client_id }, 'client authentication failed');
        oauthError(res, 401, 'invalid_client', 'client_id atau client_secret salah');
        return;
    }

    await issueTokens(res, client);
});

tokenRouter.post('/refresh', async (req, res) => {
    const { refresh_token } = req.body ?? {};
    if (!isNonEmptyString(refresh_token)) {
        oauthError(res, 400, 'invalid_request', 'refresh_token wajib diisi');
        return;
    }

    const result = consumeRefreshToken(refresh_token);
    if (!result.ok) {
        const log = getLog(res);
        if (result.reason === 'reused') log.warn({ client_id: result.clientId }, 'refresh token reuse detected, family revoked');
        else log.info({ reason: result.reason, client_id: result.clientId }, 'refresh rejected');
        oauthError(res, 401, 'invalid_grant', 'refresh_token tidak valid, kedaluwarsa, atau sudah dipakai');
        return;
    }

    const client = findClient(result.clientId);
    if (client === undefined) {
        oauthError(res, 401, 'invalid_grant', 'client tidak lagi terdaftar');
        return;
    }

    await issueTokens(res, client, result.family);
});
