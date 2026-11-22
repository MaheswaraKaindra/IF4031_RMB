import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SseParser } from './sseParser.js';
import { enc } from './testSupport.js';

test('SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    const text = ': hello\r\nid: 7\r\nevent: detection\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid: 8\nevent: update\ndata: x\n\n';
    const bytes = enc.encode(text);
    const frames = [];
    for (let i = 0; i < bytes.length; i += 3) frames.push(...p.push(bytes.slice(i, i + 3)));
    assert.deepEqual(frames, [
        { id: '7', event: 'detection', data: '{"a":\n1}' },
        { id: '8', event: 'update', data: 'x' },
    ]);
});

test('SSE parser decodes a multi-byte character split across chunks', () => {
    const p = new SseParser();
    const bytes = enc.encode('event: detection\ndata: café\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const frames = [...p.push(bytes.slice(0, cut)), ...p.push(bytes.slice(cut))];
    assert.equal(frames[0]?.data, 'café');
});
