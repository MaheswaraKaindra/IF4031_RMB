import { getMongoClient } from '../db/mongo.js';
import { logger } from '../logger.js';
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
            deadlineMs: Number(process.env.STORE_DEADLINE_MS ?? 1000),
            scanDeadlineMs: Number(process.env.STORE_SCAN_DEADLINE_MS ?? 8000),
            strictWrites: process.env.STORE_STRICT_WRITES === '1',
            writeW: w === 'majority' ? 'majority' : Number(w ?? (process.env.STORE_MODE === 'sharded' ? 2 : 1)),
            writeTimeoutMs: Number(process.env.STORE_WRITE_TIMEOUT_MS ?? 1500),
        });
        watchTopology(repo);
    }
    return repo;
}

// The ConfigMap volume is updated in place by the kubelet (~1 min after store-topology.sh republishes it).
function watchTopology(r: MongoCanonicalRepository): void {
    let last = JSON.stringify(loadTopology() ?? null);
    setInterval(() => {
        try {
            const t = loadTopology();
            const now = JSON.stringify(t ?? null);
            if (!t || now === last) return;
            last = now;
            r.setTopology(t);
            logger.info({ units: t.units.map((u) => ({ unit: u.name, nodes: u.members.filter((m) => !m.arbiter).map((m) => m.node) })) }, 'store topology reloaded');
        } catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'store topology reload failed; keeping the previous map');
        }
    }, 15_000).unref();
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
