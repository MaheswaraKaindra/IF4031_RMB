import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bulkhead, BulkheadFullError } from './bulkhead.js';
import { CircuitBreaker, DEFAULT_BREAKER, type BreakerState } from './breaker.js';

function make(overrides: Partial<typeof DEFAULT_BREAKER> = {}) {
    let t = 0;
    const transitions: string[] = [];
    const b = new CircuitBreaker({
        ...DEFAULT_BREAKER,
        openMs: 10_000,
        maxOpenMs: 60_000,
        jitter: 0,
        ...overrides,
        now: () => t,
        random: () => 0.5,
        onTransition: (from: BreakerState, to: BreakerState) => transitions.push(`${from}>${to}`),
    });
    return { b, transitions, advance: (ms: number) => void (t += ms), at: () => t };
}

test('breaker opens after the threshold within the window and rejects without calling', () => {
    const { b, transitions } = make();
    for (let i = 0; i < 4; i++) b.onFailure();
    assert.equal(b.state, 'closed');
    b.onFailure();
    assert.equal(b.state, 'open');
    assert.equal(b.allow(), false);
    assert.equal(b.counters.rejected, 1);
    assert.deepEqual(transitions, ['closed>open']);
});

test('failures spread beyond the window do not open the breaker', () => {
    const { b, advance } = make({ windowMs: 10_000 });
    for (let i = 0; i < 10; i++) {
        b.onFailure();
        advance(3_000);
    }
    assert.equal(b.state, 'closed');
});

test('a success resets the failure count while closed', () => {
    const { b } = make();
    for (let i = 0; i < 4; i++) b.onFailure();
    b.onSuccess();
    for (let i = 0; i < 4; i++) b.onFailure();
    assert.equal(b.state, 'closed');
});

test('half-open admits exactly one probe, success closes', () => {
    const { b, advance, transitions } = make();
    for (let i = 0; i < 5; i++) b.onFailure();
    advance(9_999);
    assert.equal(b.allow(), false);
    advance(1);
    assert.equal(b.state, 'half_open');
    assert.equal(b.allow(), true);
    assert.equal(b.allow(), false, 'second concurrent probe is refused');
    b.onSuccess();
    assert.equal(b.state, 'closed');
    assert.equal(b.allow(), true);
    assert.deepEqual(transitions, ['closed>open', 'open>half_open', 'half_open>closed']);
});

test('a failed probe reopens with exponential backoff capped at the maximum', () => {
    const { b, advance } = make();
    for (let i = 0; i < 5; i++) b.onFailure();
    const intervals: number[] = [];
    for (let round = 0; round < 5; round++) {
        intervals.push(b.retryInMs());
        advance(b.retryInMs());
        assert.equal(b.allow(), true);
        b.onFailure('probe');
    }
    assert.deepEqual(intervals, [10_000, 20_000, 40_000, 60_000, 60_000]);
});

test('request rate against a down dependency is bounded by probes, not by callers', () => {
    const { b, advance } = make();
    let sent = 0;
    for (let ms = 0; ms < 300_000; ms += 100) {
        if (b.allow()) {
            sent++;
            b.onFailure();
        }
        advance(100);
    }
    assert.ok(sent <= 5 + 8, `sent ${sent} requests in 5 minutes`);
});

test('jitter keeps the open interval inside its band', () => {
    let r = 0;
    for (const rnd of [0, 1]) {
        r = rnd;
        let t = 0;
        const b = new CircuitBreaker({ ...DEFAULT_BREAKER, openMs: 10_000, maxOpenMs: 60_000, jitter: 0.2, now: () => t, random: () => r });
        for (let i = 0; i < 5; i++) b.onFailure();
        const wait = b.retryInMs();
        assert.ok(wait >= 8_000 && wait <= 12_000, `wait ${wait}`);
        t += wait;
        assert.equal(b.state, 'half_open');
    }
});

test('bulkhead rejects beyond its limit and releases once', async () => {
    const bh = new Bulkhead('coastal', 1);
    const release = bh.tryAcquire();
    assert.ok(release);
    assert.equal(bh.tryAcquire(), null);
    release();
    release();
    assert.equal(bh.active, 0);
    assert.ok(bh.tryAcquire());
    await assert.rejects(bh.run(async () => 1), BulkheadFullError);
});

test('bulkhead run releases on failure', async () => {
    const bh = new Bulkhead('coastal', 1);
    await assert.rejects(
        bh.run(async () => {
            throw new Error('boom');
        }),
    );
    assert.equal(bh.active, 0);
    assert.equal(await bh.run(async () => 7), 7);
});

test('failures paced by slow timeouts still open the breaker with the default window', () => {
    // one cycle is the 1.5 s timeout plus the 1 s poll interval
    const { b, advance } = make({ windowMs: DEFAULT_BREAKER.windowMs });
    for (let i = 0; i < 5; i++) {
        b.onFailure('timeout');
        advance(2_500);
    }
    assert.equal(b.state, 'open');
    assert.ok(DEFAULT_BREAKER.windowMs > DEFAULT_BREAKER.failureThreshold * 2_500, 'window must exceed threshold x (timeout + poll interval)');
});

test('default configuration probes a dead sensor at a bounded, low rate and recovers within seconds', () => {
    let t = 0;
    const b = new CircuitBreaker({ ...DEFAULT_BREAKER, jitter: 0, now: () => t });
    let sent = 0;
    for (; t < 300_000; t += 100) {
        if (b.allow()) {
            sent++;
            b.onFailure('timeout');
        }
    }
    assert.ok(sent <= 5 + 62, `sent ${sent} requests in 5 minutes against a dead sensor (at most one probe per ${DEFAULT_BREAKER.maxOpenMs} ms)`);
    assert.ok(b.retryInMs() <= DEFAULT_BREAKER.maxOpenMs);
});
