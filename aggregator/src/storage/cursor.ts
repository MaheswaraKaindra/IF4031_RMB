import { InvalidCursorError, type SortOrder } from './types.js';

// Keyset cursor: the sort key of the last returned item, never an offset.
// Cursors are NOT snapshots: updates/retracts between pages can move records. Documented in docs/m2-details/consistency.md.
export interface CursorKey {
    s: SortOrder;
    k: string; // occurred_at or ingested_at of the last item
    h: string; // hazard_id of the last item (tie breaker)
}

export function encodeCursor(c: CursorKey): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, expectedSort: SortOrder): CursorKey {
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CursorKey>;
        if (parsed.s !== expectedSort || typeof parsed.k !== 'string' || typeof parsed.h !== 'string') {
            throw new InvalidCursorError();
        }
        return { s: parsed.s, k: parsed.k, h: parsed.h };
    } catch {
        throw new InvalidCursorError();
    }
}
