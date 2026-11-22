// P3 evidence tool, run INSIDE the aggregator pod (it owns the storage credentials):
//   kubectl -n <ns> exec <pod> -c aggregator -- node dist/tools/inbox-tool.js <cmd> [--flag value]
//
//   park --key K --levels Waspada,Awas[,...] [--poison-first]
//        Stores several versions of ONE PVMBG report (same report_id K) in the parked inbox exactly as the aggregator parks a message it could not
//        read after a schema change (renamed fields `mountain_code` / `status_level`). The LAST version is inserted FIRST on purpose, but carries the
//        latest received_at, so only an ordered replay (by received time) applies them in the right order. --poison-first makes the first version
//        unreadable even after the schema rule (an alert_level that is not a level), to show that later versions of the key then wait for it.
//   purge --key K    deletes the inbox messages and the stored event this tool created for K (only keys that start with ORD-)
//   show --key K     status, processed_at and received_at of every inbox message of the report
import { connectMongo, closeMongo, getMongoDb } from '../db/mongo.js';
import { MongoRawInbox } from '../p3/rawInbox.js';
import { hazardIdFor } from '../storage/identity.js';

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
    const cmd = process.argv[2];
    const key = arg('key');
    if (!key) throw new Error('--key is required');
    await connectMongo();
    const inbox = new MongoRawInbox(getMongoDb);
    if (cmd === 'park') {
        const levels = (arg('levels') ?? 'Waspada,Awas').split(',');
        const base = Date.now() - 60_000; // reported 60 s ago, one second apart
        const versions = levels.map((lvl, i) => ({ i, lvl, reported_at: new Date(base + i * 1000).toISOString() }));
        for (const v of [...versions].reverse()) {
            const poison = flag('poison-first') && v.i === 0;
            const raw = {
                report_id: key, mountain_code: 'VOLC-03', status_level: poison ? 'unknown-level' : v.lvl, eruption_count_24h: 3 + v.i, ash_column_height_m: 1000 + v.i, reported_at: v.reported_at,
            };
            const r = await inbox.appendFailure({
                source: 'PVMBG', source_ref_id: key, event_version: Date.parse(v.reported_at), raw: Buffer.from(JSON.stringify(raw)),
                status: 'parked', retryable: false, reason: 'schema_incompatible: missing or renamed required field \'volcano_id\'',
                received_at: new Date(base + v.i * 1000 + 500).toISOString(),
            });
            console.log(JSON.stringify({ parked: r.message_id, version: v.i + 1, level: poison ? 'unknown-level' : v.lvl, duplicate: r.duplicate }));
        }
    } else if (cmd === 'show') {
        const rows = await getMongoDb().collection('raw_inbox').find({ source: 'PVMBG', source_ref_id: key }).sort({ received_at: 1 }).project({ raw: 0 }).toArray();
        for (const r of rows) console.log(JSON.stringify({ message_id: r['_id'], status: r['status'], received_at: r['received_at'], processed_at: r['processed_at'] ?? null, reason: r['reason'] }));
    } else if (cmd === 'purge') {
        if (!key.startsWith('ORD-')) throw new Error('refusing to purge a key that is not an ORD- test key');
        const a = await getMongoDb().collection('raw_inbox').deleteMany({ source: 'PVMBG', source_ref_id: key });
        const b = await getMongoDb().collection('hazards').deleteMany({ source: 'PVMBG', source_ref_id: key, _id: hazardIdFor('PVMBG', key) as never });
        console.log(JSON.stringify({ inbox_deleted: a.deletedCount, events_deleted: b.deletedCount }));
    } else throw new Error('usage: park|show|purge --key K');
    await closeMongo();
}
// connectMongo starts a background index retry loop, so the process must exit explicitly.
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
