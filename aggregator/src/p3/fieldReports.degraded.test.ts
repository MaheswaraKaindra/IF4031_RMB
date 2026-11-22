import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoFieldReportOutbox } from './fieldReports.js';
import { resetReactiveDegraded } from '../storage/health.js';

// A collection whose first insert fails the way a store with a missing member does (write concern timeout), later inserts work.
function fakeDb(behaviour: 'wtimeout-once' | 'dup-after-wtimeout') {
    const docs = new Map<string, unknown>(); let calls = 0;
    const coll = {
        insertOne: async (d: { _id: string }) => {
            calls++;
            if (calls === 1) {
                if (behaviour === 'dup-after-wtimeout') docs.set(d._id, d); // applied on one copy before the timeout
                throw Object.assign(new Error('waiting for replication timed out'), { code: 64, codeName: 'WriteConcernFailed' });
            }
            if (docs.has(d._id)) throw Object.assign(new Error('E11000'), { code: 11000 });
            docs.set(d._id, d); return {};
        },
        findOne: async (q: { _id: string }) => docs.get(q._id) ?? null,
    };
    return { db: { collection: () => coll } as never, calls: () => calls };
}
const body = { report_id: 'R-1', hazard_type: 'COASTAL', severity: 'AWAS', area_name: 'Padang', latitude: -0.95, longitude: 100.35, occurred_at: '2026-11-20T12:00:00Z' };

test('a write concern timeout on the first insert still ends in 202 after one more insert', async () => {
    resetReactiveDegraded();
    const f = fakeDb('wtimeout-once');
    const r = await new MongoFieldReportOutbox(() => f.db).accept({ body, principal: 'field-team', correlationId: 'c' });
    assert.equal(r.status, 202); assert.equal(f.calls(), 2);
});

test('when the first insert had in fact been applied, the second one is answered as an accepted duplicate, not as an error', async () => {
    resetReactiveDegraded();
    const f = fakeDb('dup-after-wtimeout');
    const r = await new MongoFieldReportOutbox(() => f.db).accept({ body, principal: 'field-team', correlationId: 'c' });
    assert.equal(r.status, 202);
});
