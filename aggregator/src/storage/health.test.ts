import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { bookkeepingOptions, isStoreDegraded, isWriteConcernTimeout, noteBookkeepingFailure, resetReactiveDegraded, setStoreDegraded } from './health.js';

afterEach(() => { resetReactiveDegraded(); setStoreDegraded(false); delete process.env.STORE_MODE; delete process.env.STORE_WRITE_W; });

test('bookkeeping writes keep w:2 while the store is healthy and drop to w:1 only while degraded', () => {
    process.env.STORE_MODE = 'sharded';
    assert.equal(bookkeepingOptions()?.writeConcern.w, 2);
    setStoreDegraded(true, 'shard-1');
    assert.equal(isStoreDegraded(), true);
    assert.equal(bookkeepingOptions()?.writeConcern.w, 1);
    setStoreDegraded(false);
    assert.equal(bookkeepingOptions()?.writeConcern.w, 2);
});

test('a single-node store keeps the client default', () => {
    delete process.env.STORE_MODE;
    setStoreDegraded(true);
    assert.equal(bookkeepingOptions(), undefined);
});

test('a write concern timeout switches bookkeeping to w:1 at once, without waiting for the prober, and expires by itself', () => {
    process.env.STORE_MODE = 'sharded';
    const t0 = 1_000_000;
    assert.equal(isStoreDegraded(t0), false);
    assert.equal(noteBookkeepingFailure(new Error('waiting for replication timed out; Error details: { wtimeout: true }'), t0), true);
    assert.equal(isStoreDegraded(t0 + 1000), true);
    assert.equal(isStoreDegraded(t0 + 20_000), false, 'the window ends and w:2 comes back unless another failure extends it');
    noteBookkeepingFailure(Object.assign(new Error('x'), { code: 64 }), t0 + 20_000);
    assert.equal(isStoreDegraded(t0 + 25_000), true);
});

test('other errors are not mistaken for a write concern timeout', () => {
    assert.equal(isWriteConcernTimeout(new Error('connection refused')), false);
    assert.equal(isWriteConcernTimeout(Object.assign(new Error('dup'), { code: 11000 })), false);
    assert.equal(noteBookkeepingFailure(new Error('connection refused')), false);
    assert.equal(isStoreDegraded(), false);
    assert.equal(isWriteConcernTimeout(Object.assign(new Error('write failed'), { writeConcernError: { code: 64 } })), true);
});
