import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryFeedLog } from './log.js';
import { pollSessionOnce } from './sessionMonitor.js';
import { silent } from './testSupport.js';

test('session monitor publishes source lag as feed offset minus the durable log tail', async () => {
    const log = new InMemoryFeedLog();
    await log.append([0, 1, 2, 3].map((o) => ({ offset: o, kind: 'detection', raw: '{}', received_at: 'x' })));
    const gauges = new Map<string, number>();
    const fetchImpl = (async () => new Response(JSON.stringify({ latest_offset: 10, virtual_now: '2026-12-08T00:00:00Z', speed: 60 }), { status: 200 })) as typeof fetch;
    await pollSessionOnce({
        baseUrl: 'http://x', token: 't', log, logger: silent, fetchImpl,
        metrics: { inc() {}, observe() {}, set: (n, _l, v) => void gauges.set(n, v) },
    });
    assert.equal(gauges.get('satellite_source_offset_lag'), 7);
    assert.equal(gauges.get('satellite_virtual_now_seconds'), Date.parse('2026-12-08T00:00:00Z') / 1000);
    assert.equal(gauges.get('satellite_feed_speed'), 60);
});
