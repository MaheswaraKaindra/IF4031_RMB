import { getMongoClient } from '../db/mongo.js';
import { MongoCanonicalRepository } from './mongoRepository.js';
import { loadTopology } from './topology.js';
import type {
    AnalyticsQuery, GlobalQuery, ICanonicalRepository, IngestInput, Source,
} from './types.js';

let repo: MongoCanonicalRepository | undefined;

export function getRepository(): MongoCanonicalRepository {
    if (!repo) {
        const w = process.env.STORE_WRITE_W;
        repo = new MongoCanonicalRepository({
            client: getMongoClient(),
            topology: loadTopology(),
            probeUser: process.env.STORE_PROBE_USER,
            probePassword: process.env.STORE_PROBE_PASSWORD,
            deadlineMs: Number(process.env.STORE_DEADLINE_MS ?? 1500),
            strictWrites: process.env.STORE_STRICT_WRITES === '1',
            writeW: w === 'majority' ? 'majority' : Number(w ?? (process.env.STORE_MODE === 'sharded' ? 2 : 1)),
            writeTimeoutMs: Number(process.env.STORE_WRITE_TIMEOUT_MS ?? 1500),
        });
    }
    return repo;
}

// Lets routes be mounted before Mongo is connected; every call resolves the repository at call time.
export function lazyRepository(): ICanonicalRepository {
    return {
        ingest: (i: IngestInput) => getRepository().ingest(i),
        getById: (id: string) => getRepository().getById(id),
        remove: (id: string, epoch?: number) => getRepository().remove(id, epoch),
        queryGlobal: (q: GlobalQuery) => getRepository().queryGlobal(q),
        aggregate: (q: AnalyticsQuery) => getRepository().aggregate(q),
        checksum: (s?: Source) => getRepository().checksum(s),
        locate: (id: string) => getRepository().locate(id),
        unitStatus: () => getRepository().unitStatus(),
    };
}
