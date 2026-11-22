/** Errors after which a field report may or may not have been stored: the aggregator did not answer in time or the connection broke. */
export function isUncertainOutcome(error: unknown): boolean {
    const e = error as { code?: string; response?: unknown };
    return e.response === undefined && typeof e.code === 'string' && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(e.code);
}

/** Runs `attempt` once more when the first outcome is uncertain. Safe only for an idempotent write (the aggregator stores a field report under its idempotency key, a second POST answers 202 `duplicate`). */
export async function retryUncertain<T>(attempt: (n: number) => Promise<T>): Promise<T> {
    try {
        return await attempt(1);
    } catch (error) {
        if (!isUncertainOutcome(error)) throw error;
        return attempt(2);
    }
}
