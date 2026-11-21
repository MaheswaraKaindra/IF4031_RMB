// Interface-only contracts for Owners B and C. A owns ICanonicalRepository (implemented); the interfaces below are
// proposed shapes so B/C can write fakes and tests now. The implementing owner may change them: tell A when they do.
// Pattern to follow for every one of them: ONE conditional write that checks the owner epoch and mutates state
// together (see MongoCanonicalRepository.ingest), never "read fence, then write".

// ---- Message envelope (P3/P4/P5) ---------------------------------------------------------------------------------
export interface Envelope<T = unknown> {
    message_id: string;          // transport identity (changes per publish attempt/replay)
    source: string;              // BMKG | PVMBG | SATELIT | SENSOR_PANTAI | FIELD_TEAM
    source_ref_id: string;       // business identity (stable across replays)
    event_type: string;
    schema_version: string;
    event_version?: number | undefined; // monotonic per source_ref_id when the source provides it
    payload: T | { raw_ref: string };   // raw_ref points into IRawInbox when the payload is not parseable
    occurred_at?: string | undefined;
    received_at: string;
    correlation_id: string;
    trace?: { traceparent?: string | undefined } | undefined;
    attempt: number;
}

export type ErrorClass =
    | 'validation'        // permanent: payload violates the contract            -> park
    | 'schema'            // permanent until the decoder/schema changes          -> park
    | 'authorization'
    | 'transient'         // dependency down/slow                                 -> retry with backoff + jitter
    | 'conflict'          // stale version / stale epoch                          -> drop silently, already superseded
    | 'unknown_outcome';  // commit may or may not have happened                  -> retry idempotently or read back

// ---- Checkpoints (P2/P4): position in a source stream --------------------------------------------------------------
export interface Checkpoint {
    source: string;
    partition: string;
    received_offset: string;    // input durably stored (safe to ack upstream)
    committed_offset: string;   // effects of everything <= this offset are durable
    state_version: number;
    owner_epoch: number;
}
export interface ICheckpoint {
    get(source: string, partition: string): Promise<Checkpoint | null>;
    // Compare-and-set on (state_version) AND owner_epoch >= stored epoch, in one operation.
    commit(next: Checkpoint, expectedStateVersion: number): Promise<'applied' | 'stale_epoch' | 'conflict' | 'unavailable'>;
}

// ---- Raw inbox (P3): bytes first, interpretation later ---------------------------------------------------------------
export type InboxStatus = 'received' | 'processing' | 'processed' | 'retrying' | 'parked';
export interface InboxRecord {
    message_id: string;
    source: string;
    received_at: string;
    raw: Buffer;                // stored as binary: invalid UTF-8 / truncated JSON must survive untouched
    raw_sha256: string;
    status: InboxStatus;
    reason?: string | undefined;
    retryable?: boolean | undefined;
    attempts: number;
    next_attempt_at?: string | undefined;
    claim_token?: string | undefined;
    claim_expires_at?: string | undefined;
}
export interface IRawInbox {
    append(rec: Pick<InboxRecord, 'message_id' | 'source' | 'received_at' | 'raw'>): Promise<'stored' | 'duplicate' | 'unavailable'>;
    claim(limit: number, visibilityMs: number): Promise<InboxRecord[]>;       // expired claims become claimable again
    mark(id: string, claimToken: string, status: Exclude<InboxStatus, 'received' | 'processing'>, reason?: string, retryable?: boolean): Promise<boolean>;
    replay(filter: { source?: string | undefined; reason?: string | undefined }, maxPerSecond: number): Promise<number>;
    listUnprocessed(q: { source?: string | undefined; limit: number; cursor?: string | undefined }): Promise<{ items: InboxRecord[]; next_cursor: string | null }>;
}
