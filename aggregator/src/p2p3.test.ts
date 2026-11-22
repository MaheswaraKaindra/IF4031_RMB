import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { InMemoryCheckpointStore } from './coordination/checkpoints.js';
import { fencedIngest, InMemorySourceFenceStore } from './coordination/fencing.js';
import { SourceLeaderManager } from './coordination/leaderLoop.js';
import { InMemoryLeaseProvider, toK8sMicroTime } from './coordination/lease.js';
import { metrics } from './observability.js';
import { parseBoundedRawJson } from './p3/boundedJson.js';
import { InMemoryFieldReportOutbox, relayPendingOutboxBatch } from './p3/fieldReports.js';
import { InMemoryRawInbox } from './p3/rawInbox.js';
import { defaultSchemaRules, validateAndMapPvmbgRecord, validateFieldReport } from './p3/schemaValidator.js';
import { hazardIdFor } from './storage/identity.js';
import { InMemoryRepository } from './storage/memory.js';
import type { HazardRecord } from './storage/types.js';

const silentLog = pino({ level: 'silent' });

function sampleEvent(ref: string, over: Partial<HazardRecord> = {}): HazardRecord {
    return {
        hazard_id: hazardIdFor('BMKG', ref),
        source: 'BMKG',
        source_ref_id: ref,
        hazard_type: 'SEISMIC',
        severity: 'WASPADA',
        area_name: 'Selat Sunda',
        latitude: -6.1,
        longitude: 105.4,
        occurred_at: '2026-11-18T10:00:00.000Z',
        ingested_at: '2026-11-18T10:00:05.000Z',
        attributes: {},
        ...over,
    };
}

test('P2: single active leader, monotonic epoch, freeze + stale commit rejected even for brand-new records', async () => {
    const lease = new InMemoryLeaseProvider();
    const fences = new InMemorySourceFenceStore();
    const checkpoints = new InMemoryCheckpointStore();
    const repo = new InMemoryRepository(3);

    let monoA = 1000;
    let monoB = 1000;
    const mgrA = new SourceLeaderManager({
        source: 'BMKG',
        leaseName: 'aggregator-poller-bmkg',
        identity: 'pod-a',
        leaseDurationMs: 20_000,
        renewDeadlineMs: 12_000,
        retryPeriodMs: 3000,
        leaseProvider: lease,
        fenceStore: fences,
        logger: silentLog,
        nowMono: () => monoA,
    });
    const mgrB = new SourceLeaderManager({
        source: 'BMKG',
        leaseName: 'aggregator-poller-bmkg',
        identity: 'pod-b',
        leaseDurationMs: 20_000,
        renewDeadlineMs: 12_000,
        retryPeriodMs: 3000,
        leaseProvider: lease,
        fenceStore: fences,
        logger: silentLog,
        nowMono: () => monoB,
    });

    assert.equal(await mgrA.step(), true);
    assert.equal(await mgrB.step(), false);
    assert.equal(mgrA.getStatus().epoch, 1);

    // Grab handle before A freezes
    const staleHandle = await mgrA.acquirePollHandle(1000);
    assert.ok(staleHandle);
    assert.equal(staleHandle.epoch, 1);

    // A freezes past leaseDuration (25s); B takes over with epoch 2
    lease.clockMs += 25_000;
    monoB += 25_000;
    assert.equal(await mgrB.step(), true);
    assert.equal(mgrB.getStatus().epoch, 2);

    // Case 1: A wakes up (monoA jumped too) and tries to commit -> local monotonic guard rejects immediately
    monoA += 25_000;
    const staleWrite1 = await fencedIngest(repo, fences, { event: sampleEvent('eq-new-1'), epoch: staleHandle.epoch }, staleHandle.isStillValid);
    assert.equal(staleWrite1.outcome, 'stale_epoch');
    assert.equal(await repo.getById(hazardIdFor('BMKG', 'eq-new-1')), null);

    // Case 2: Even if A's local clock hadn't noticed yet (worst-case race), DB source_fences rejects stale epoch 1!
    const staleWrite2 = await fencedIngest(repo, fences, { event: sampleEvent('eq-new-2'), epoch: 1 }, () => true);
    assert.equal(staleWrite2.outcome, 'stale_epoch');
    assert.equal(await repo.getById(hazardIdFor('BMKG', 'eq-new-2')), null);

    // Checkpoint commit from stale epoch 1 is also rejected after B commits epoch 2
    assert.equal(
        await checkpoints.commit(
            { source: 'BMKG', partition: 'default', received_offset: 't2', committed_offset: 't2', state_version: 1, owner_epoch: 2 },
            0
        ),
        'applied'
    );
    assert.equal(
        await checkpoints.commit(
            { source: 'BMKG', partition: 'default', received_offset: 't1', committed_offset: 't1', state_version: 1, owner_epoch: 1 },
            0
        ),
        'stale_epoch'
    );

    // On A's next tick, A drops to follower and stays follower
    assert.equal(await mgrA.step(), false);
    assert.equal(mgrA.getStatus().isLeader, false);
});

test('P3: bounded JSON parser rejects truncated, deeply nested, invalid UTF-8, and oversized payloads safely', () => {
    const limits = { maxBytes: 1024, maxDepth: 8 };

    assert.equal(parseBoundedRawJson(Buffer.from('{"a": 1', 'utf8'), limits).ok, false);
    const truncated = parseBoundedRawJson(Buffer.from('{"a": 1', 'utf8'), limits);
    assert.equal(truncated.ok === false && truncated.code, 'malformed_json');

    const deep = Buffer.from('['.repeat(12) + '1' + ']'.repeat(12), 'utf8');
    const deepRes = parseBoundedRawJson(deep, limits);
    assert.equal(deepRes.ok === false && deepRes.code, 'max_depth_exceeded');

    const badUtf8 = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const utf8Res = parseBoundedRawJson(badUtf8, limits);
    assert.equal(utf8Res.ok === false && utf8Res.code, 'invalid_utf8');

    const big = Buffer.alloc(2048, 0x20);
    const bigRes = parseBoundedRawJson(big, limits);
    assert.equal(bigRes.ok === false && bigRes.code, 'payload_too_large');

    // Brackets inside strings must not trigger false max_depth_exceeded
    const strWithBrackets = Buffer.from(JSON.stringify({ note: '[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]' }), 'utf8');
    assert.equal(parseBoundedRawJson(strWithBrackets, limits).ok, true);
});

test('P3: schema evolution policy, raw byte preservation, per-key ordered replay, and audit exclusion', async () => {
    const inbox = new InMemoryRawInbox();
    const repo = new InMemoryRepository(3);
    const rulesV1 = defaultSchemaRules();

    // Additive field is accepted automatically into attributes
    const additive = validateAndMapPvmbgRecord(
        {
            report_id: 'REP-1',
            volcano_id: 'VOLC-01',
            alert_level: 'Waspada',
            eruption_count_24h: 2,
            ash_column_height_m: 1200,
            reported_at: '2026-11-18T09:00:00Z',
            confidence_level: 0.91,
        },
        rulesV1
    );
    assert.equal(additive.ok, true);
    if (additive.ok) assert.equal(additive.value.attributes['confidence_level'], 0.91);

    // Incompatible rename & type change are rejected
    const v2Payload1 = {
        report_id: 'REP-KEY-1',
        mountain_code: 'VOLC-02', // renamed from volcano_id
        status_level: 'Siaga', // renamed from alert_level
        eruption_count_24h: 'three', // type change
        ash_column_height_m: 1500,
        reported_at: '2026-11-18T10:00:00Z',
    };
    const v2Payload2 = {
        report_id: 'REP-KEY-1',
        mountain_code: 'VOLC-02',
        status_level: 'Awas',
        eruption_count_24h: 5,
        ash_column_height_m: 3200,
        reported_at: '2026-11-18T10:05:00Z',
    };
    assert.equal(validateAndMapPvmbgRecord(v2Payload1, rulesV1).ok, false);

    // Invalid UTF-8 preserved byte-for-byte
    const rawBadBytes = Buffer.from([0x7b, 0x80, 0xfe, 0x7d]);
    const badAppend = await inbox.appendFailure({
        source: 'PVMBG',
        raw: rawBadBytes,
        status: 'parked',
        retryable: false,
        reason: 'invalid_utf8',
    });
    assert.deepEqual(inbox.getRawById(badAppend.message_id), rawBadBytes);

    // Two failed records on the same source_ref_id (REP-KEY-1)
    await inbox.appendFailure({
        message_id: 'msg-rep-1',
        source: 'PVMBG',
        source_ref_id: 'REP-KEY-1',
        event_version: 100,
        raw: Buffer.from(JSON.stringify(v2Payload1), 'utf8'),
        status: 'parked',
        retryable: false,
        reason: 'schema_incompatible: rename',
    });
    await inbox.appendFailure({
        message_id: 'msg-rep-2',
        source: 'PVMBG',
        source_ref_id: 'REP-KEY-1',
        event_version: 200,
        raw: Buffer.from(JSON.stringify(v2Payload2), 'utf8'),
        status: 'parked',
        retryable: false,
        reason: 'schema_incompatible: rename',
    });

    // Per-key ordering: while msg-rep-1 is still incompatible (under rulesV1), msg-rep-2 is blocked even if valid
    const blockedCheck = await inbox.replay({ source: 'PVMBG' }, async (rec) => {
        if (rec.message_id === 'msg-rep-2') return { ok: true };
        return { ok: false, retryable: false, reason: rec.reason ?? 'still incompatible' };
    }, 100);
    assert.equal(blockedCheck.still_failed, 2); // badAppend + msg-rep-1
    assert.equal(blockedCheck.blocked_by_key, 1); // msg-rep-2 blocked by msg-rep-1!

    // Now Ops enables v2 schema adapter and replays -> both REP-KEY-1 records recover in order (final severity AWAS)
    const rulesV2 = {
        enablePvmbgV2Compat: true,
        fieldAliases: { mountain_code: 'volcano_id', status_level: 'alert_level' },
        coerceNumericStrings: true,
        defaults: {},
    };
    const replayOk = await inbox.replay(
        { source: 'PVMBG' },
        async (rec) => {
            const p = parseBoundedRawJson(rec.raw, { maxBytes: 10240, maxDepth: 32 });
            if (!p.ok) return { ok: false, retryable: false, reason: p.reason };
            const m = validateAndMapPvmbgRecord(p.value, rulesV2);
            if (!m.ok) return { ok: false, retryable: false, reason: m.reason };
            await repo.ingest({ event: m.value as never, eventVersion: rec.event_version });
            return { ok: true };
        },
        100
    );
    assert.equal(replayOk.recovered, 2);
    const stored = await repo.getById(hazardIdFor('PVMBG', 'REP-KEY-1'));
    assert.equal(stored?.severity, 'AWAS');

    // Recovered records disappear from /internal/audit/unprocessed; only invalid UTF-8 remains parked
    const unprocessed = await inbox.list({ source: 'PVMBG', limit: 100 });
    assert.equal(unprocessed.items.length, 1);
    assert.equal(unprocessed.items[0]!.message_id, badAppend.message_id);
});

test('P3: durable POST /field-reports 202 survives crash before/after broker publish without loss or duplicate', async () => {
    const outbox = new InMemoryFieldReportOutbox();
    const repo = new InMemoryRepository(3);

    const payload = {
        report_id: 'FR-2026-001',
        hazard_type: 'COASTAL',
        severity: 'AWAS',
        area_name: 'Pesisir Padang',
        latitude: -0.95,
        longitude: 100.35,
        occurred_at: '2026-11-18T11:00:00Z',
    };

    const r1 = await outbox.accept({ body: payload, principal: 'field-team', idempotencyKey: 'idem-1', correlationId: 'c1' });
    assert.equal(r1.status, 202);
    assert.equal(r1.status === 202 && r1.duplicate, false);

    // Retry with same key and payload -> idempotent 202, no duplicate outbox entry
    const r2 = await outbox.accept({ body: payload, principal: 'field-team', idempotencyKey: 'idem-1', correlationId: 'c2' });
    assert.equal(r2.status, 202);
    assert.equal(r2.status === 202 && r2.duplicate, true);
    assert.equal(await outbox.pendingCount(), 1);

    // Same key with different payload -> 409 conflict
    const rConflict = await outbox.accept({
        body: { ...payload, severity: 'NORMAL' },
        principal: 'field-team',
        idempotencyKey: 'idem-1',
        correlationId: 'c3',
    });
    assert.equal(rConflict.status, 409);

    // Simulate broker down right after 202 -> relay fails cleanly, record stays pending (NOT lost)
    const relayFail = await relayPendingOutboxBatch(outbox, repo, {
        publishConfirmed: async () => {
            throw new Error('broker down');
        },
    });
    assert.equal(relayFail.failed, 1);
    assert.equal(await outbox.pendingCount(), 1);

    // Simulate broker recovers after visibility expiry -> outbox relays and marks published; canonical count is exactly 1
    let publishedCount = 0;
    // Wait briefly for backoff in InMemoryFieldReportOutbox (100ms)
    await new Promise((r) => setTimeout(r, 120));
    const relayOk = await relayPendingOutboxBatch(outbox, repo, {
        publishConfirmed: async () => {
            publishedCount += 1;
        },
    });
    assert.equal(relayOk.published, 1);
    assert.equal(publishedCount, 1);
    assert.equal(await outbox.pendingCount(), 0);
    assert.equal((await repo.checksum()).count, 1);
});

test('K8s MicroTime formatting, field-report validation, and Prometheus metrics render cleanly', () => {
    assert.match(toK8sMicroTime(Date.UTC(2026, 10, 18, 12, 0, 0, 123)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    assert.equal(validateFieldReport({ report_id: '', hazard_type: 'COASTAL' }).ok, false);
    assert.equal(
        validateFieldReport({
            report_id: 'FR-VALID',
            hazard_type: 'WILDFIRE',
            severity: 'SIAGA',
            area_name: 'Riau',
            latitude: 0.5,
            longitude: 101.4,
            occurred_at: '2026-11-18T12:00:00Z',
        }).ok,
        true
    );

    metrics.inc('http_requests_total', { service: 'aggregator', method: 'GET', route: '/health', status: '200' });
    const text = metrics.render();
    assert.ok(text.includes('# TYPE http_requests_total counter'));
    assert.ok(text.includes('http_requests_total{method="GET",route="/health",service="aggregator",status="200"}'));
});
