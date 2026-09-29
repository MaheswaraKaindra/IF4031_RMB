function intFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} harus berupa bilangan bulat positif`);
    }
    return value;
}

export const config = {
    port: intFromEnv('CLIENT_API_PORT', 8080),
    aggregatorUrl: process.env.AGGREGATOR_URL || 'http://localhost:3000',
    aggregatorTimeoutMs: intFromEnv('AGGREGATOR_TIMEOUT_MS', 2000),
    staleAfterMs: intFromEnv('STALE_AFTER_MS', 15000),
    maxInFlight: intFromEnv('MAX_IN_FLIGHT', 100),
    logLevel: process.env.LOG_LEVEL || 'info',
};
