import { MongoClient, type Collection, type Db } from 'mongodb';
import type { HazardEvent } from '../utils/mapper.js';
import { logger } from '../logger.js';
import { bookkeepingOptions } from '../storage/health.js';

export interface SourceStatusDoc {
    _id: 'BMKG' | 'PVMBG' | 'SENSOR_PANTAI';
    last_success_at?: string;
    // Present only while the latest poll of this source failed, removed again by the next success
    last_failure_at?: string;
}

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connectMongo(): Promise<void> {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set');

    // STORE_MODE=sharded: records are keyed by deterministic _id (= hazard_id, the hashed shard key), writes
    // wait for 2 data members, reads prefer the primary but fall back to a secondary during an election.
    const sharded = isSharded();
    client = new MongoClient(uri, {
        serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS ?? 2000),
        // A restarted store pod must be noticed in seconds: the defaults (30 s connect, 10 s heartbeat) stalled every write path for ~30 s.
        connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS ?? 2000),
        heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS ?? 1000),
        ...(sharded ? { readPreference: 'primaryPreferred' as const, writeConcern: { w: Number(process.env.STORE_WRITE_W ?? 2), wtimeoutMS: Number(process.env.STORE_WRITE_TIMEOUT_MS ?? 1500) } } : {}),
    });
    await client.connect();
    db = client.db();

    // Query-supporting indexes. Sharded: building them needs EVERY shard, so a restart/reschedule while a unit is down must not
    // crash-loop the aggregator (that is exactly when it gets rescheduled): keep retrying in the background; reads, ingestion
    // (degraded acks) and the partial-aware audit API keep working without them (the bootstrap Job already created them).
    if (sharded) {
        void ensureIndexesWithRetry();
    } else {
        await ensureIndexes(false);
    }
    logger.info({ store_mode: sharded ? 'sharded' : 'single' }, 'Connected to MongoDB');
}

async function ensureIndexes(sharded: boolean): Promise<void> {
    // Non-unique indexes are fine on a sharded collection.
    await getHazards().createIndex({ occurred_at: -1, hazard_id: 1 });
    await getHazards().createIndex({ ingested_at: 1, hazard_id: 1 });
    await getHazards().createIndex({ source: 1, source_ref_id: 1 }, sharded ? {} : { unique: true });
    // Unique secondary indexes cannot span shards unless prefixed by the shard key; identity is enforced by _id instead.
    if (!sharded) await getHazards().createIndex({ hazard_id: 1 }, { unique: true });
}

async function ensureIndexesWithRetry(): Promise<void> {
    for (;;) {
        try {
            await ensureIndexes(true);
            logger.info('query indexes ensured');
            return;
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'could not ensure indexes (a shard is unreachable?); retrying in 15s');
            await new Promise((r) => setTimeout(r, 15_000));
        }
    }
}

export function isSharded(): boolean {
    return process.env.STORE_MODE === 'sharded';
}

export function getMongoClient(): MongoClient {
    if (!client) throw new Error('MongoDB not connected');
    return client;
}

export function getMongoDb(): Db {
    if (!db) throw new Error('MongoDB not connected');
    return db;
}

export async function pingMongo(timeoutMs: number): Promise<boolean> {
    if (!db) return false;
    const timeout = new Promise<false>((resolve) => setTimeout(resolve, timeoutMs, false).unref());
    const ping = db.command({ ping: 1 }).then(() => true, () => false);
    return Promise.race([ping, timeout]);
}

export async function closeMongo(): Promise<void> {
    await client?.close();
}

export function getHazards(): Collection<HazardEvent> {
    if (!db) throw new Error('MongoDB not connected');
    return db.collection<HazardEvent>('hazards');
}

export function getSourceStatus(): Collection<SourceStatusDoc> {
    if (!db) throw new Error('MongoDB not connected');
    return db.collection<SourceStatusDoc>('source_status', bookkeepingOptions());
}
