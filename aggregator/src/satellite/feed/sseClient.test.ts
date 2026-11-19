import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeedIngestor } from './ingestor.js';
import { InMemoryFeedLog } from './log.js';
import { detectionData, offsets, range, silent, sseBlock, sseHead, startFeed, waitFor } from './testSupport.js';

test('disconnect mid-stream resumes at tail+1 with no gap and no duplicate', async () => {
    const feed = await startFeed((res, from, attempt) => {
        sseHead(res);
        if (attempt === 1) {
            for (let o = from; o < 5; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
            setTimeout(() => res.destroy(), 50);
            return;
        }
        for (let o = from; o < 12; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 'tok', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 11);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(12));
    assert.equal(feed.requests[0]?.from, 0);
    assert.equal(feed.requests[1]?.from, 5);
    assert.equal(feed.requests[0]?.auth, 'Bearer tok');
});

test('replayed overlap and duplicate frames are skipped by offset', async () => {
    const feed = await startFeed((res) => {
        sseHead(res);
        for (const o of [0, 1, 2, 2, 1, 3, 4]) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 4);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(5));
    assert.equal(client.stats.duplicatesSkipped >= 2, true);
});

test('an offset gap is never delivered: the client reconnects from the expected offset', async () => {
    const feed = await startFeed((res, from, attempt) => {
        sseHead(res);
        if (attempt === 1) {
            res.write(sseBlock(0, 'detection', detectionData(0)));
            res.write(sseBlock(1, 'detection', detectionData(1)));
            res.write(sseBlock(4, 'detection', detectionData(4)));
            return;
        }
        for (let o = from; o < 6; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 5);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(6));
    assert.equal(client.stats.gapsDetected, 1);
    assert.equal(feed.requests[1]?.from, 2);
});

test('a restarted process resumes from the durable log, not from memory', async () => {
    const feed = await startFeed((res, from) => {
        sseHead(res);
        for (let o = from; o < 8; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    await log.append(range(5).map((o) => ({ offset: o, kind: 'detection', raw: detectionData(o), received_at: 'x' })));
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 7);
    ac.abort();
    await run;
    await feed.close();
    assert.equal(feed.requests[0]?.from, 5);
    assert.deepEqual(await offsets(log), range(8));
});

test('a handler failure drops the connection and the same frame is delivered again from the durable position', async () => {
    const feed = await startFeed((res, from) => {
        sseHead(res);
        for (let o = from; o < 4; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const realAppend = log.append.bind(log);
    let failed = false;
    log.append = async (entries) => {
        if (!failed && entries[0]?.offset === 2) {
            failed = true;
            throw new Error('store unavailable');
        }
        return realAppend(entries);
    };
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 3);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(4));
    assert.equal(feed.requests[1]?.from, 2);
});

test('429 and 503 are retried with backoff and the stream resumes afterwards', async () => {
    const feed = await startFeed((res, from, attempt) => {
        if (attempt === 1) {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
            res.end('{"error":{"code":"too_many_connections","message":"x"}}');
            return;
        }
        if (attempt === 2) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end('{"error":{"code":"unavailable","message":"x"}}');
            return;
        }
        sseHead(res);
        for (let o = from; o < 3; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 2);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(3));
    assert.equal(client.stats.lastError, 'HTTP 503');
});

test('a silent stream is abandoned after the idle timeout and reopened', async () => {
    const feed = await startFeed((res, from, attempt) => {
        sseHead(res);
        res.write(': open\n\n');
        if (attempt === 1) return;
        for (let o = from; o < 2; o++) res.write(sseBlock(o, 'detection', detectionData(o)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, idleTimeoutMs: 80, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 1);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(2));
    assert.equal(feed.requests.length >= 2, true);
});

test('a heartbeat consumes an offset: it is stored and does not look like a gap', async () => {
    const feed = await startFeed((res, from) => {
        sseHead(res);
        for (let o = from; o < 4; o++) {
            if (o === 2) res.write(sseBlock(o, 'heartbeat', '{"offset":2,"virtual_now":"2026-12-08T06:27:40Z"}'));
            else res.write(sseBlock(o, 'detection', detectionData(o)));
        }
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 3);
    ac.abort();
    await run;
    await feed.close();
    assert.deepEqual(await offsets(log), range(4));
    assert.equal(client.stats.gapsDetected, 0);
    assert.equal((await log.read(2, 1))[0]?.kind, 'heartbeat');
});

test('malformed frames are stored raw with their offset and do not stop the stream', async () => {
    const feed = await startFeed((res) => {
        sseHead(res);
        res.write(sseBlock(0, 'detection', detectionData(0)));
        res.write(sseBlock(1, 'detection', '{"offset":1,"det'));
        res.write(sseBlock(2, 'mystery', '{"offset":2}'));
        res.write(sseBlock(3, 'detection', detectionData(3)));
    });
    const log = new InMemoryFeedLog();
    const client = createFeedIngestor({ baseUrl: feed.url, token: 't', logger: silent, log, backoffBaseMs: 1, backoffMaxMs: 5 });
    const ac = new AbortController();
    const run = client.run(ac.signal);
    await waitFor(async () => (await log.tail()) === 3);
    ac.abort();
    await run;
    await feed.close();
    const stored = await log.read(0, 10);
    assert.equal(stored.length, 4);
    assert.equal(stored[1]?.raw, '{"offset":1,"det');
    assert.equal(client.stats.invalidFrames, 2);
});
