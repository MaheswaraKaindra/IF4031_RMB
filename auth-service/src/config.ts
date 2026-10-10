function intFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function sha256HexFromEnv(name: string): string {
    const value = requiredEnv(name);
    if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${name} must be a SHA-256 hash (64 hex)`);
    }
    return value;
}

export const config = {
    port: intFromEnv('AUTH_PORT', 8090),
    logLevel: process.env.LOG_LEVEL || 'info',
    jwtPrivateKeyPem: Buffer.from(requiredEnv('JWT_PRIVATE_KEY_B64'), 'base64').toString('utf8'),
    jwtIssuer: process.env.JWT_ISSUER || 'bnpb-auth',
    jwtAudience: process.env.JWT_AUDIENCE || 'bnpb-client-api',
    accessTokenTtlSeconds: intFromEnv('ACCESS_TOKEN_TTL_SECONDS', 60),
    refreshTokenTtlSeconds: intFromEnv('REFRESH_TOKEN_TTL_SECONDS', 3600),
    maxFailedAttempts: intFromEnv('AUTH_MAX_FAILED_ATTEMPTS', 10),
    failureWindowSeconds: intFromEnv('AUTH_FAILURE_WINDOW_SECONDS', 60),
    clientSecretHashes: {
        media: sha256HexFromEnv('AUTH_CLIENT_MEDIA_SECRET_SHA256'),
        'field-team': sha256HexFromEnv('AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256'),
        'bnpb-ops': sha256HexFromEnv('AUTH_CLIENT_BNPB_OPS_SECRET_SHA256'),
    },
};
