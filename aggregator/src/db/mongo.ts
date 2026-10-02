import { MongoClient, type Collection, type Db } from 'mongodb';
import type { HazardEvent } from '../utils/mapper.js';
import { logger } from '../logger.js';

export interface SourceStatusDoc {
    _id: 'BMKG' | 'PVMBG';
    last_success_at: string;
}

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connectMongo(): Promise<void> {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI belum diatur');

    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db();

    await getHazards().createIndex({ source: 1, source_ref_id: 1 }, { unique: true });
    await getHazards().createIndex({ occurred_at: -1 });
    logger.info('Berhasil terhubung ke MongoDB');
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
    if (!db) throw new Error('MongoDB belum terhubung');
    return db.collection<HazardEvent>('hazards');
}

export function getSourceStatus(): Collection<SourceStatusDoc> {
    if (!db) throw new Error('MongoDB belum terhubung');
    return db.collection<SourceStatusDoc>('source_status');
}
