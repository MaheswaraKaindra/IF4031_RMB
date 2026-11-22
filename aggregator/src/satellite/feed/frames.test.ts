import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame } from './frames.js';
import { detectionData } from './testSupport.js';

test('detection key keeps the raw latitude text and the unpadded acquisition time', () => {
    const ev = decodeFrame({ id: '0', event: 'detection', data: detectionData(0, {}, '5.10000') });
    assert.equal(ev.kind, 'detection');
    if (ev.kind !== 'detection') return;
    assert.equal(ev.detection.key, 'N20|2026-12-07|15|5.10000|96.99091');
    assert.equal(new Date(ev.detection.time_ms).toISOString(), '2026-12-07T00:15:00.000Z');
});

test('update and retract frames decode, malformed frames become invalid with their offset', () => {
    const up = decodeFrame({ id: '5', event: 'update', data: '{"offset":5,"key":"k","changes":{"frp":9.5,"confidence":"h","bright_ti4":1}}' });
    assert.deepEqual(up, { kind: 'update', offset: 5, key: 'k', changes: { frp_mw: 9.5, confidence: 'h' } });
    const rt = decodeFrame({ id: '6', event: 'retract', data: '{"offset":6,"key":"k","reason":"false_positive"}' });
    assert.deepEqual(rt, { kind: 'retract', offset: 6, key: 'k', reason: 'false_positive' });
    assert.equal(decodeFrame({ id: '9', event: 'detection', data: '{"offset":9,"detection":{"satellite":"N"}}' }).kind, 'invalid');
    const trunc = decodeFrame({ id: '10', event: 'detection', data: '{"offset":10,"det' });
    assert.deepEqual(trunc, { kind: 'invalid', offset: 10, reason: 'data is not valid JSON' });
    assert.equal(decodeFrame({ id: '11', event: 'detection', data: detectionData(11, { confidence: 'x' }) }).kind, 'invalid');
    assert.deepEqual(
        decodeFrame({ id: '12', event: 'heartbeat', data: '{"offset":12,"virtual_now":"2026-12-08T06:27:40Z"}' }),
        { kind: 'heartbeat', offset: 12, virtualNowMs: Date.parse('2026-12-08T06:27:40Z') }
    );
});
