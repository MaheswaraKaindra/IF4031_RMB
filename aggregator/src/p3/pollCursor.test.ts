import assert from 'node:assert/strict';
import test from 'node:test';
import { sinceWithOverlap } from './pollCursor.js';

test('the poll starts earlier than the cursor by the overlap', () => {
    assert.equal(sinceWithOverlap('2026-11-21T10:00:00.000Z', 120_000), '2026-11-21T09:58:00.000Z');
});

test('a cursor written by a clock 45 s ahead still covers every event since real time', () => {
    const real = Date.parse('2026-11-21T10:00:00.000Z');
    const cursorFromFastClock = new Date(real + 45_000).toISOString();
    const since = Date.parse(sinceWithOverlap(cursorFromFastClock, 120_000));
    assert.equal(since <= real, true, 'events dated from real time onwards are not skipped');
});

test('the start of time and unusable values are left alone', () => {
    assert.equal(sinceWithOverlap('1970-01-01T00:00:00.000Z', 120_000), '1970-01-01T00:00:00.000Z');
    assert.equal(sinceWithOverlap('not a date', 120_000), 'not a date');
    assert.equal(sinceWithOverlap('2026-11-21T10:00:00.000Z', 0), '2026-11-21T10:00:00.000Z');
});
