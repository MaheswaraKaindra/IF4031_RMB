import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { bookkeepingOptions, isStoreDegraded, setStoreDegraded } from './health.js';

afterEach(() => { setStoreDegraded(false); delete process.env.STORE_MODE; delete process.env.STORE_WRITE_W; });

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
