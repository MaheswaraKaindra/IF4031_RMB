import { createHash } from 'node:crypto';

// Deterministic identity [default for open decision O-1]: the same (source, source_ref_id) always gets
// the same hazard_id, on every instance, after every replay. It doubles as the Mongo _id and hashed
// shard key, so global uniqueness needs no unique index spanning shards.
// Change HAZARD_ID_SCHEME only together with a data migration.
export function hazardIdFor(source: string, sourceRefId: string): string {
    const digest = createHash('sha256').update(`${source}\u0000${sourceRefId}`).digest('hex');
    return `hz-${digest.slice(0, 16)}`;
}
