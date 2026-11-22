import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseObserver } from './lease.js';

test('a lease is expired only after this process saw no change for its whole duration, whatever the wall clocks say', () => {
    let mono = 1_000;
    const o = new LeaseObserver(() => mono);
    // first sight of a held lease starts the timer: never expired immediately, even if its renewTime looks ancient
    assert.equal(o.isExpired('l', 'a|2020-01-01T00:00:00Z|1', true, 20_000), false);
    mono += 19_000;
    assert.equal(o.isExpired('l', 'a|2020-01-01T00:00:00Z|1', true, 20_000), false);
    mono += 2_000; // 21 s without a change
    assert.equal(o.isExpired('l', 'a|2020-01-01T00:00:00Z|1', true, 20_000), true);
});

test('every observed renewal restarts the timer, even when the renewTime written by a drifted API server is far in the future or the past', () => {
    let mono = 0;
    const o = new LeaseObserver(() => mono);
    const keys = ['a|2026-11-20T10:00:45Z|1', 'a|2026-11-20T09:59:20Z|2', 'a|2026-11-20T10:00:50Z|3'];
    for (const k of keys) {
        assert.equal(o.isExpired('l', k, true, 20_000), false);
        mono += 10_000; // renewed every 10 s: never expires although the stamps jump +45 s / -30 s
    }
});

test('a released lease (no holder) is expired at once, so a clean shutdown hands over immediately', () => {
    const o = new LeaseObserver(() => 0);
    assert.equal(o.isExpired('l', '||5', false, 20_000), true);
});
