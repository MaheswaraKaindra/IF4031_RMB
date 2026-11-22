import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceparent, startChildSpan } from './observability.js';

test('a child span keeps the trace id, gets a new span id and hands its own traceparent to the next hop', () => {
    const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const span = startChildSpan('store ingest', parent, 'CLIENT');
    const child = parseTraceparent(span.traceparent);
    assert.equal(child?.traceId, 'a'.repeat(32));
    assert.notEqual(child?.parentSpanId, 'b'.repeat(16));
    span.end(true);
    span.end(false); // a second end is ignored
});

test('without a parent traceparent there is no span and the next hop gets none', () => {
    const span = startChildSpan('store ingest', undefined, 'CLIENT');
    assert.equal(span.traceparent, undefined);
    span.end(true);
});
