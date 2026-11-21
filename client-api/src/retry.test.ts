import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUncertainOutcome, retryUncertain } from './retry.js';

test('a timeout or a broken connection is an uncertain outcome, an HTTP answer or a validation error is not', () => {
    assert.equal(isUncertainOutcome({ code: 'ECONNABORTED' }), true);
    assert.equal(isUncertainOutcome({ code: 'ECONNRESET' }), true);
    assert.equal(isUncertainOutcome({ code: 'ECONNABORTED', response: { status: 500 } }), false);
    assert.equal(isUncertainOutcome({ code: 'ERR_BAD_REQUEST' }), false);
    assert.equal(isUncertainOutcome(new Error('x')), false);
});

test('the write is attempted a second time after an uncertain failure and the answer of that attempt is returned', async () => {
    let calls = 0;
    const out = await retryUncertain(async (n) => { calls++; if (n === 1) throw Object.assign(new Error('timeout of 2000ms exceeded'), { code: 'ECONNABORTED' }); return 'accepted'; });
    assert.equal(out, 'accepted'); assert.equal(calls, 2);
});

test('a definite failure is not retried and a second uncertain failure is surfaced', async () => {
    let calls = 0;
    await assert.rejects(retryUncertain(async () => { calls++; throw Object.assign(new Error('bad'), { code: 'ERR_BAD_REQUEST' }); }));
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(retryUncertain(async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); }));
    assert.equal(calls, 2);
});
