import { randomUUID } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';
import type { Logger } from 'pino';

import {
    pickStrongestWarning,
    recomputeSeverityFromWarning,
    warningRank,
    type HazardEvent,
} from './utils/mapper.js';
import { closeMongo, connectMongo, getMongoDb, isSharded, pingMongo } from './db/mongo.js';
import { createStorageRouter } from './storage/routes.js';
import { lazyRepository } from './storage/runtime.js';
import {
    attachTsunamiWarning,
    findHazardBySourceRef,
    findHazards,
    findHazardsPaged,
    getSourceStatuses,
    markSourceFailure,
    markSourceSuccess,
} from './db/hazardRepository.js';
import { HAZARD_TYPES, SOURCES, type HazardType, type Severity, type Source } from './storage/types.js';
import { InvalidCursorError } from './storage/types.js';
import { CORRELATION_HEADER, errorMessage, getLog, logger, requestLogger, timed } from './logger.js';
import { emitSpan, metrics, metricsAndTracingMiddleware, metricsEndpoint, newSpanContext } from './observability.js';
import { KubernetesLeaseProvider, MongoLeaseProvider, type ILeaseProvider } from './coordination/lease.js';
import { fencedIngest, MongoSourceFenceStore } from './coordination/fencing.js';
import { MongoCheckpointStore } from './coordination/checkpoints.js';
import { SourceLeaderManager, type LeaderLeaseHandle } from './coordination/leaderLoop.js';
import { parseBoundedRawJson } from './p3/boundedJson.js';
import {
    defaultSchemaRules,
    validateAndMapBmkgRecord,
    validateAndMapPvmbgRecord,
    type SchemaRulesConfig,
} from './p3/schemaValidator.js';
import { computeBackoffWithJitter, MongoRawInbox, type RawInboxItem } from './p3/rawInbox.js';
import { MongoFieldReportOutbox, relayPendingOutboxBatch, type FieldReportOutboxRecord } from './p3/fieldReports.js';

const PORT = Number(process.env.AGGREGATOR_PORT || 3000);
const STORAGE_API_PORT = Number(process.env.STORAGE_API_PORT || 3001);
const POD_IDENTITY = process.env.POD_NAME || process.env.HOSTNAME || `agg-${randomUUID().slice(0, 8)}`;

const BMKG_URL = process.env.BMKG_URL || 'http://localhost:8081';
const PVMBG_URL = process.env.PVMBG_URL || 'http://localhost:8082';
const X_BMKG_KEY = process.env.X_BMKG_KEY;
const PVMBG_TOKEN = process.env.PVMBG_TOKEN;
if (!X_BMKG_KEY || !/^bmkg_[0-9a-f]{64}$/.test(X_BMKG_KEY)) {
    logger.fatal('X_BMKG_KEY must be set with format bmkg_<64 hex>');
    process.exit(1);
}
if (!PVMBG_TOKEN || !/^pvmbg\.v1\.[A-Za-z0-9_-]{43}$/.test(PVMBG_TOKEN)) {
    logger.fatal('PVMBG_TOKEN must be set with format pvmbg.v1.<43 base64url chars>');
    process.exit(1);
}

const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10);
const LEASE_DURATION_MS = parseInt(process.env.LEASE_DURATION_SEC || '20', 10) * 1000;
const LEASE_RENEW_DEADLINE_MS = parseInt(process.env.LEASE_RENEW_DEADLINE_SEC || '12', 10) * 1000;
const LEASE_RETRY_PERIOD_MS = parseInt(process.env.LEASE_RETRY_PERIOD_SEC || '3', 10) * 1000;
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || '262144', 10); // 256 KiB
const MAX_JSON_DEPTH = parseInt(process.env.MAX_JSON_DEPTH || '32', 10);
const INBOX_MAX_ATTEMPTS = parseInt(process.env.INBOX_MAX_ATTEMPTS || '5', 10);
const REPLAY_MAX_PER_SEC = parseInt(process.env.REPLAY_MAX_PER_SEC || '50', 10);

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const EXCHANGE = 'hazard_events';
const CRITICAL_EXCHANGE = 'hazard_critical';
const CRITICAL_QUEUE = 'q_critical_alerts';
const RECONNECT_DELAY_MS = 5000;
const MAX_PENDING_PUBLISH = 10_000;

const repo = lazyRepository();
const fenceStore = new MongoSourceFenceStore(getMongoDb);
const checkpointStore = new MongoCheckpointStore(getMongoDb);
const rawInbox = new MongoRawInbox(getMongoDb);
const fieldReportOutbox = new MongoFieldReportOutbox(getMongoDb);

let schemaRules: SchemaRulesConfig = defaultSchemaRules();
const polling = { BMKG: false, PVMBG: false };
let shuttingDown = false;

let rabbitChannel: amqp.ConfirmChannel | undefined;
let rabbitConnection: amqp.ChannelModel | undefined;

interface PendingPublish {
    event: HazardEvent;
    correlationId: string;
    traceparent?: string | undefined;
}
let pendingPublish: PendingPublish[] = [];

function bufferEvent(item: PendingPublish, log: Logger): void {
    if (pendingPublish.length >= MAX_PENDING_PUBLISH) pendingPublish.shift();
    pendingPublish.push(item);
    log.warn({ pending: pendingPublish.length }, 'RabbitMQ unavailable, HazardEvent buffered for later publish');
}

function sendToBroker(item: PendingPublish, log: Logger): void {
    const channel = rabbitChannel;
    if (!channel) {
        bufferEvent(item, log);
        return;
    }
    const { event, correlationId, traceparent } = item;
    try {
        channel.publish(
            EXCHANGE,
            '',
            Buffer.from(JSON.stringify(event)),
            {
                contentType: 'application/json',
                messageId: `${event.hazard_id}:${event.severity}`,
                correlationId,
                headers: traceparent ? { traceparent } : {},
                persistent: true,
            },
            (error) => {
                if (error) bufferEvent(item, log);
                else log.info({ hazard_id: event.hazard_id, source: event.source, severity: event.severity }, 'Published HazardEvent');
            }
        );
    } catch {
        bufferEvent(item, log);
    }
}

function publishConfirmedToBroker(
    exchange: string,
    routingKey: string,
    payload: Buffer,
    options: amqp.Options.Publish
): Promise<void> {
    return new Promise((resolve, reject) => {
        const channel = rabbitChannel;
        if (!channel) {
            reject(new Error('RabbitMQ channel unavailable'));
            return;
        }
        try {
            channel.publish(exchange, routingKey, payload, options, (err) => {
                if (err) reject(err);
                else resolve();
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function publishFieldReportOutboxRecord(record: FieldReportOutboxRecord): Promise<void> {
    const payload = Buffer.from(JSON.stringify(record.hazard_event));
    const props: amqp.Options.Publish = {
        contentType: 'application/json',
        messageId: `${record.hazard_event.hazard_id}:${record.hazard_event.severity}`,
        correlationId: record.correlation_id,
        headers: {
            ...(record.traceparent ? { traceparent: record.traceparent } : {}),
            idempotency_key: record.idempotency_key,
        },
        persistent: true,
    };
    await Promise.all([
        publishConfirmedToBroker(EXCHANGE, '', payload, props),
        publishConfirmedToBroker(CRITICAL_EXCHANGE, 'critical.field_report', payload, props),
    ]);
}

function flushPendingPublish(): void {
    if (pendingPublish.length === 0) return;
    const items = pendingPublish;
    pendingPublish = [];
    logger.info({ count: items.length }, 'Publishing buffered HazardEvents');
    for (const item of items) sendToBroker(item, logger.child({ correlation_id: item.correlationId }));
}

async function initRabbitMQ(): Promise<void> {
    if (shuttingDown) return;
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createConfirmChannel();
        await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });
        await channel.assertExchange(CRITICAL_EXCHANGE, 'direct', { durable: true });
        await channel.assertQueue(CRITICAL_QUEUE, { durable: true });
        await channel.bindQueue(CRITICAL_QUEUE, CRITICAL_EXCHANGE, 'critical.field_report');
        await channel.bindQueue(CRITICAL_QUEUE, CRITICAL_EXCHANGE, 'critical.coastal');

        connection.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'RabbitMQ connection error'));
        connection.on('close', () => {
            rabbitChannel = undefined;
            rabbitConnection = undefined;
            if (shuttingDown) return;
            logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'RabbitMQ connection lost');
            setTimeout(initRabbitMQ, RECONNECT_DELAY_MS).unref();
        });

        rabbitConnection = connection;
        rabbitChannel = channel;
        logger.info('Connected to RabbitMQ');
        flushPendingPublish();
        void runOutboxRelay();
    } catch (error) {
        logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Failed to connect to RabbitMQ');
        setTimeout(initRabbitMQ, RECONNECT_DELAY_MS).unref();
    }
}

function createLeaseProvider(): ILeaseProvider {
    const mode = process.env.COORDINATION_MODE ?? (process.env.KUBERNETES_SERVICE_HOST ? 'k8s' : 'db');
    if (mode === 'k8s') {
        logger.info({ identity: POD_IDENTITY }, 'Using Kubernetes Lease API for leader election');
        return new KubernetesLeaseProvider();
    }
    logger.info({ identity: POD_IDENTITY }, 'Using MongoDB server-time Lease provider for leader election');
    return new MongoLeaseProvider(getMongoDb);
}

let bmkgLeader: SourceLeaderManager | undefined;
let pvmbgLeader: SourceLeaderManager | undefined;

async function fetchRawUpstream(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal
): Promise<Buffer> {
    const res = await axios.get<ArrayBuffer>(url, {
        headers: {
            ...headers,
            'x-aggregator-pod': POD_IDENTITY,
        },
        timeout: timeoutMs,
        signal,
        responseType: 'arraybuffer',
        maxContentLength: MAX_PAYLOAD_BYTES * 2,
        maxBodyLength: MAX_PAYLOAD_BYTES * 2,
        transformResponse: [(data) => data],
    });
    return Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
}

async function applyLateWarnings(
    events: any[],
    warnings: any[],
    handle: LeaderLeaseHandle,
    log: Logger,
    correlationId: string,
    traceparent: string
): Promise<boolean> {
    const batchEventIds = new Set(events.map((e) => e?.event_id));
    const lateEventIds = new Set<string>();
    for (const w of warnings) {
        if (typeof w?.related_event_id === 'string' && !batchEventIds.has(w.related_event_id)) lateEventIds.add(w.related_event_id);
    }

    for (const eventId of lateEventIds) {
        if (!handle.isStillValid()) return false;
        try {
            const stored = await findHazardBySourceRef('BMKG', eventId);
            if (!stored) continue;

            const w = pickStrongestWarning(warnings, eventId);
            const current = stored.attributes.tsunami_warning;
            if (current !== undefined && warningRank(current) >= warningRank(w)) continue;

            const newSeverity = recomputeSeverityFromWarning(w);
            if (!handle.isStillValid() || !(await fenceStore.assertEpoch('BMKG', handle.epoch))) return false;
            if (!(await attachTsunamiWarning(stored.hazard_id, newSeverity, w, handle.epoch))) continue;

            log.info(
                { hazard_id: stored.hazard_id, old_severity: stored.severity, new_severity: newSeverity, leader_epoch: handle.epoch },
                'Late tsunami warning applied to stored event'
            );
            if (newSeverity !== stored.severity) {
                const event = { ...stored, severity: newSeverity, attributes: { ...stored.attributes, tsunami_warning: w } };
                sendToBroker({ event, correlationId, traceparent }, log);
            }
        } catch (error) {
            log.error({ related_event_id: eventId, error: errorMessage(error) }, 'Failed to apply late warning');
        }
    }
    return true;
}

async function ingestFencedRecord(
    event: HazardEvent,
    handle: LeaderLeaseHandle,
    rawItem: unknown,
    eventVersion: number | undefined,
    log: Logger,
    correlationId: string,
    traceparent: string
): Promise<'ok' | 'stale_epoch' | 'transient_queued'> {
    // Per-key ordering: if an earlier record for this source_ref_id failed/is parked, hold this one too
    if (await rawInbox.hasBlockingFailure(event.source, event.source_ref_id)) {
        await rawInbox.appendFailure({
            source: event.source,
            source_ref_id: event.source_ref_id,
            event_version: eventVersion,
            raw: Buffer.from(JSON.stringify(rawItem)),
            status: 'retrying',
            retryable: true,
            reason: `ordered_wait: blocked by earlier unprocessed record for ${event.source_ref_id}`,
            next_attempt_at: new Date(Date.now() + 2000).toISOString(),
        });
        metrics.inc('aggregator_inbox_messages_total', { source: event.source, status: 'retrying' });
        return 'transient_queued';
    }

    const res = await fencedIngest(
        repo,
        fenceStore,
        { event, eventVersion, epoch: handle.epoch },
        handle.isStillValid
    );

    if (res.outcome === 'stale_epoch') {
        log.warn({ hazard_id: res.hazard_id, leader_epoch: handle.epoch }, 'stale leader epoch rejected during commit');
        return 'stale_epoch';
    }
    if (res.outcome === 'unavailable') {
        metrics.inc('aggregator_storage_unavailable_total');
        await rawInbox.appendFailure({
            source: event.source,
            source_ref_id: event.source_ref_id,
            event_version: eventVersion,
            raw: Buffer.from(JSON.stringify(rawItem)),
            status: 'retrying',
            retryable: true,
            reason: `transient_storage: ${res.detail ?? 'storage unavailable'}`,
            next_attempt_at: new Date(Date.now() + computeBackoffWithJitter(1)).toISOString(),
        });
        metrics.inc('aggregator_inbox_messages_total', { source: event.source, status: 'retrying' });
        return 'transient_queued';
    }
    if (res.created) {
        sendToBroker({ event, correlationId, traceparent }, log);
    }
    return 'ok';
}

async function pollBmkg(): Promise<void> {
    if (!bmkgLeader || polling.BMKG || shuttingDown) return;
    const handle = await bmkgLeader.acquirePollHandle(2500);
    if (!handle) {
        metrics.inc('aggregator_poll_total', { source: 'BMKG', outcome: 'skipped_not_leader' });
        return;
    }

    const span = newSpanContext();
    const wallStart = Date.now();
    const monoStart = performance.now();
    const correlationId = `poll-${randomUUID()}`;
    const log = logger.child({
        correlation_id: correlationId,
        trace_id: span.traceId,
        source: 'BMKG',
        leader_epoch: handle.epoch,
    });

    polling.BMKG = true;
    try {
        const cp = await checkpointStore.get('BMKG', 'default');
        const sinceCursor = cp?.committed_offset ?? new Date(0).toISOString();
        const fetchTime = new Date().toISOString();

        const headers = {
            'X-BMKG-Key': X_BMKG_KEY!,
            [CORRELATION_HEADER]: correlationId,
            traceparent: span.traceparent,
            'x-leader-epoch': String(handle.epoch),
        };

        let eventsBuf: Buffer;
        let warningsBuf: Buffer;
        try {
            [eventsBuf, warningsBuf] = await Promise.all([
                timed(log, 'bmkg', 'GET /seismic-events', () =>
                    fetchRawUpstream(`${BMKG_URL}/seismic-events?since=${encodeURIComponent(sinceCursor)}`, headers, 2000, handle.signal)
                ),
                timed(log, 'bmkg', 'GET /tsunami-warnings', () =>
                    fetchRawUpstream(`${BMKG_URL}/tsunami-warnings?since=${encodeURIComponent(sinceCursor)}`, headers, 2000, handle.signal)
                ),
            ]);
        } catch (error) {
            metrics.inc('aggregator_poll_total', { source: 'BMKG', outcome: handle.signal.aborted ? 'aborted' : 'error' });
            log.error({ error: errorMessage(error) }, 'Failed to fetch BMKG data');
            await markSourceFailure('BMKG').catch(() => undefined);
            return;
        }

        const parsedEvents = parseBoundedRawJson(eventsBuf, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: MAX_JSON_DEPTH });
        const parsedWarnings = parseBoundedRawJson(warningsBuf, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: MAX_JSON_DEPTH });
        if (!parsedEvents.ok) {
            await rawInbox.appendFailure({
                source: 'BMKG',
                raw: eventsBuf,
                status: 'parked',
                retryable: false,
                reason: parsedEvents.reason,
            });
            metrics.inc('aggregator_inbox_messages_total', { source: 'BMKG', status: 'parked' });
            return;
        }
        const events = Array.isArray(parsedEvents.value) ? parsedEvents.value : [];
        const warnings = parsedWarnings.ok && Array.isArray(parsedWarnings.value) ? parsedWarnings.value : [];

        let allCommitted = true;
        for (const raw of events) {
            if (!handle.isStillValid()) {
                allCommitted = false;
                break;
            }
            const strongest = pickStrongestWarning(warnings, (raw as Record<string, unknown>)?.['event_id'] as string);
            const validated = validateAndMapBmkgRecord(raw, strongest);
            if (!validated.ok) {
                await rawInbox.appendFailure({
                    source: 'BMKG',
                    source_ref_id: validated.sourceRefId,
                    raw: Buffer.from(JSON.stringify(raw ?? null)),
                    status: 'parked',
                    retryable: false,
                    reason: validated.reason,
                });
                metrics.inc('aggregator_inbox_messages_total', { source: 'BMKG', status: 'parked' });
                continue;
            }
            const evVersion = Date.parse(validated.value.occurred_at) || undefined;
            const status = await ingestFencedRecord(validated.value, handle, raw, evVersion, log, correlationId, span.traceparent);
            if (status === 'stale_epoch') {
                allCommitted = false;
                break;
            }
            if (status === 'transient_queued') allCommitted = false;
        }

        if (allCommitted && handle.isStillValid()) {
            const warningsOk = await applyLateWarnings(events, warnings, handle, log, correlationId, span.traceparent);
            if (warningsOk && handle.isStillValid()) {
                const cpRes = await checkpointStore.commit(
                    {
                        source: 'BMKG',
                        partition: 'default',
                        received_offset: fetchTime,
                        committed_offset: fetchTime,
                        state_version: (cp?.state_version ?? 0) + 1,
                        owner_epoch: handle.epoch,
                    },
                    cp?.state_version ?? 0
                );
                if (cpRes === 'applied') {
                    await markSourceSuccess('BMKG');
                    metrics.inc('aggregator_poll_total', { source: 'BMKG', outcome: 'ok' });
                } else {
                    log.warn({ checkpoint_result: cpRes, leader_epoch: handle.epoch }, 'Checkpoint rejected by fence');
                }
            }
        }
    } catch (error) {
        metrics.inc('aggregator_poll_total', { source: 'BMKG', outcome: 'error' });
        log.error({ error: errorMessage(error) }, 'BMKG poll failed');
    } finally {
        const durSec = (performance.now() - monoStart) / 1000;
        metrics.observe('aggregator_poll_duration_seconds', { source: 'BMKG' }, durSec);
        emitSpan({
            traceId: span.traceId,
            spanId: span.spanId,
            name: 'poll BMKG',
            kind: 'CLIENT',
            startMs: wallStart,
            endMs: wallStart + durSec * 1000,
            ok: true,
            attributes: { source: 'BMKG', leader_epoch: handle.epoch, 'x-correlation-id': correlationId },
        });
        polling.BMKG = false;
    }
}

async function pollPvmbg(): Promise<void> {
    if (!pvmbgLeader || polling.PVMBG || shuttingDown) return;
    const handle = await pvmbgLeader.acquirePollHandle(5500);
    if (!handle) {
        metrics.inc('aggregator_poll_total', { source: 'PVMBG', outcome: 'skipped_not_leader' });
        return;
    }

    const span = newSpanContext();
    const wallStart = Date.now();
    const monoStart = performance.now();
    const correlationId = `poll-${randomUUID()}`;
    const log = logger.child({
        correlation_id: correlationId,
        trace_id: span.traceId,
        source: 'PVMBG',
        leader_epoch: handle.epoch,
    });

    polling.PVMBG = true;
    try {
        const cp = await checkpointStore.get('PVMBG', 'default');
        const sinceCursor = cp?.committed_offset ?? new Date(0).toISOString();
        const fetchTime = new Date().toISOString();

        let rawBuf: Buffer;
        try {
            rawBuf = await timed(log, 'pvmbg', 'GET /volcanic-reports', () =>
                fetchRawUpstream(
                    `${PVMBG_URL}/volcanic-reports?since=${encodeURIComponent(sinceCursor)}`,
                    {
                        Authorization: `Bearer ${PVMBG_TOKEN!}`,
                        [CORRELATION_HEADER]: correlationId,
                        traceparent: span.traceparent,
                        'x-leader-epoch': String(handle.epoch),
                    },
                    5000,
                    handle.signal
                )
            );
        } catch (error) {
            metrics.inc('aggregator_poll_total', { source: 'PVMBG', outcome: handle.signal.aborted ? 'aborted' : 'error' });
            log.warn({ error: errorMessage(error) }, 'PVMBG did not respond (outage / timeout)');
            await markSourceFailure('PVMBG').catch(() => undefined);
            return;
        }

        const parsed = parseBoundedRawJson(rawBuf, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: MAX_JSON_DEPTH });
        if (!parsed.ok) {
            log.warn({ reason: parsed.reason }, 'PVMBG malformed byte stream quarantined');
            await rawInbox.appendFailure({
                source: 'PVMBG',
                raw: rawBuf,
                status: 'parked',
                retryable: false,
                reason: parsed.reason,
            });
            metrics.inc('aggregator_inbox_messages_total', { source: 'PVMBG', status: 'parked' });
            return;
        }

        if (!Array.isArray(parsed.value)) {
            await rawInbox.appendFailure({
                source: 'PVMBG',
                raw: rawBuf,
                status: 'parked',
                retryable: false,
                reason: 'schema_incompatible: PVMBG response must be a JSON array',
            });
            metrics.inc('aggregator_inbox_messages_total', { source: 'PVMBG', status: 'parked' });
            return;
        }

        let allCommitted = true;
        for (const raw of parsed.value) {
            if (!handle.isStillValid()) {
                allCommitted = false;
                break;
            }
            const validated = validateAndMapPvmbgRecord(raw, schemaRules);
            if (!validated.ok) {
                log.warn({ source_ref_id: validated.sourceRefId, reason: validated.reason }, 'PVMBG incompatible record parked');
                await rawInbox.appendFailure({
                    source: 'PVMBG',
                    source_ref_id: validated.sourceRefId,
                    raw: Buffer.from(JSON.stringify(raw ?? null)),
                    status: 'parked',
                    retryable: false,
                    reason: validated.reason,
                });
                metrics.inc('aggregator_inbox_messages_total', { source: 'PVMBG', status: 'parked' });
                continue;
            }
            const evVersion = Date.parse(validated.value.occurred_at) || undefined;
            const status = await ingestFencedRecord(validated.value, handle, raw, evVersion, log, correlationId, span.traceparent);
            if (status === 'stale_epoch') {
                allCommitted = false;
                break;
            }
            if (status === 'transient_queued') allCommitted = false;
        }

        if (allCommitted && handle.isStillValid()) {
            const cpRes = await checkpointStore.commit(
                {
                    source: 'PVMBG',
                    partition: 'default',
                    received_offset: fetchTime,
                    committed_offset: fetchTime,
                    state_version: (cp?.state_version ?? 0) + 1,
                    owner_epoch: handle.epoch,
                },
                cp?.state_version ?? 0
            );
            if (cpRes === 'applied') {
                await markSourceSuccess('PVMBG');
                metrics.inc('aggregator_poll_total', { source: 'PVMBG', outcome: 'ok' });
            } else {
                log.warn({ checkpoint_result: cpRes, leader_epoch: handle.epoch }, 'Checkpoint rejected by fence');
            }
        }
    } catch (error) {
        metrics.inc('aggregator_poll_total', { source: 'PVMBG', outcome: 'error' });
        log.error({ error: errorMessage(error) }, 'PVMBG poll failed');
    } finally {
        const durSec = (performance.now() - monoStart) / 1000;
        metrics.observe('aggregator_poll_duration_seconds', { source: 'PVMBG' }, durSec);
        emitSpan({
            traceId: span.traceId,
            spanId: span.spanId,
            name: 'poll PVMBG',
            kind: 'CLIENT',
            startMs: wallStart,
            endMs: wallStart + durSec * 1000,
            ok: true,
            attributes: { source: 'PVMBG', leader_epoch: handle.epoch, 'x-correlation-id': correlationId },
        });
        polling.PVMBG = false;
    }
}

async function processInboxRecord(item: RawInboxItem): Promise<{ ok: true } | { ok: false; retryable: boolean; reason: string }> {
    const parsed = parseBoundedRawJson(item.raw, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: MAX_JSON_DEPTH });
    if (!parsed.ok) {
        return { ok: false, retryable: false, reason: parsed.reason };
    }

    let event: HazardEvent | undefined;
    if (item.source === 'PVMBG') {
        const mapped = validateAndMapPvmbgRecord(parsed.value, schemaRules);
        if (!mapped.ok) return { ok: false, retryable: false, reason: mapped.reason };
        event = mapped.value;
    } else if (item.source === 'BMKG') {
        const mapped = validateAndMapBmkgRecord(parsed.value);
        if (!mapped.ok) return { ok: false, retryable: false, reason: mapped.reason };
        event = mapped.value;
    } else {
        return { ok: false, retryable: false, reason: `unsupported_replay_source: ${item.source}` };
    }

    const evVersion = item.event_version ?? (Date.parse(event.occurred_at) || undefined);
    const res = await repo.ingest({ event: event as never, eventVersion: evVersion });
    if (res.outcome === 'unavailable') {
        return { ok: false, retryable: true, reason: `transient_storage: ${res.detail ?? 'unavailable'}` };
    }
    if (res.created) {
        sendToBroker({ event, correlationId: `replay-${item.message_id}` }, logger);
    }
    return { ok: true };
}

let runningRetryWorker = false;
async function runInboxRetryWorker(): Promise<void> {
    if (runningRetryWorker || shuttingDown) return;
    runningRetryWorker = true;
    try {
        const claimed = await rawInbox.claimRetryable(10, 15_000);
        for (const item of claimed) {
            if (item.source_ref_id && (await rawInbox.hasBlockingFailure(item.source, item.source_ref_id, item.created_seq))) {
                await rawInbox.markFailed(item.message_id, {
                    claimToken: item.claim_token,
                    retryable: true,
                    reason: `ordered_wait: blocked by earlier record for ${item.source_ref_id}`,
                    maxAttempts: INBOX_MAX_ATTEMPTS,
                    backoffMs: 2000,
                });
                continue;
            }
            const result = await processInboxRecord(item);
            if (result.ok) {
                await rawInbox.markProcessed(item.message_id, item.claim_token);
                metrics.inc('aggregator_inbox_messages_total', { source: item.source, status: 'processed' });
            } else {
                await rawInbox.markFailed(item.message_id, {
                    claimToken: item.claim_token,
                    retryable: result.retryable,
                    reason: result.reason,
                    maxAttempts: INBOX_MAX_ATTEMPTS,
                });
            }
        }
        const counts = await rawInbox.countsByStatus();
        metrics.set('aggregator_inbox_unprocessed', { status: 'retrying' }, counts.retrying);
        metrics.set('aggregator_inbox_unprocessed', { status: 'parked' }, counts.parked);
    } catch (err) {
        logger.warn({ error: errorMessage(err) }, 'Inbox retry worker tick failed');
    } finally {
        runningRetryWorker = false;
    }
}

let runningOutboxRelay = false;
async function runOutboxRelay(): Promise<void> {
    if (runningOutboxRelay || shuttingDown) return;
    runningOutboxRelay = true;
    try {
        await relayPendingOutboxBatch(
            fieldReportOutbox,
            repo,
            { publishConfirmed: publishFieldReportOutboxRecord },
            25,
            10_000
        );
        const pending = await fieldReportOutbox.pendingCount();
        metrics.set('aggregator_outbox_pending', {}, pending);
    } catch (err) {
        logger.warn({ error: errorMessage(err) }, 'Outbox relay tick failed');
    } finally {
        runningOutboxRelay = false;
    }
}

// ---- Express App (:3000 internal API) ------------------------------------------------------------
const app = express();
app.use(metricsAndTracingMiddleware('aggregator'));
app.use(requestLogger);

app.get('/metrics', metricsEndpoint);

app.get('/health', async (_req, res) => {
    if (shuttingDown) {
        res.status(503).json({ status: 'draining', service: 'aggregator', pod: POD_IDENTITY });
        return;
    }
    const storeConnected = await pingMongo(1000);
    res.status(storeConnected ? 200 : 503).json({
        status: storeConnected ? 'ok' : 'degraded',
        service: 'aggregator',
        pod: POD_IDENTITY,
        store_connected: storeConnected,
        broker_connected: rabbitChannel !== undefined,
        leadership: {
            BMKG: bmkgLeader?.getStatus() ?? null,
            PVMBG: pvmbgLeader?.getStatus() ?? null,
        },
    });
});

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    return null;
}

app.get('/internal/events', async (req, res) => {
    const hazard_type = parseEnum<HazardType>(req.query.hazard_type, HAZARD_TYPES);
    const severity = parseEnum<Severity>(req.query.severity, ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS']);
    const source = parseEnum<Source>(req.query.source, SOURCES);
    if (hazard_type === null || severity === null || source === null) {
        res.status(400).json({ error: 'hazard_type, severity, or source is invalid' });
        return;
    }

    let since: string | undefined;
    const sinceParam = req.query.since;
    if (sinceParam !== undefined) {
        if (typeof sinceParam !== 'string' || Number.isNaN(Date.parse(sinceParam))) {
            res.status(400).json({ error: 'since must be an ISO 8601 date' });
            return;
        }
        since = new Date(sinceParam).toISOString();
    }

    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ error: 'limit must be an integer >= 1' });
        return;
    }

    try {
        if (isSharded()) {
            const page = await timed(getLog(res), 'mongo', 'find hazards (sharded)', () =>
                findHazardsPaged({ hazard_type, severity, source, since }, limit)
            );
            res.json(page.partial ? { events: page.events, partial: true, unavailable_units: page.unavailable_units } : { events: page.events });
            return;
        }
        const events = await timed(getLog(res), 'mongo', 'find hazards', () =>
            findHazards({ hazard_type, severity, source, since }, limit)
        );
        res.json({ events });
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Failed to read events');
        res.status(503).json({ error: 'Canonical Store unavailable' });
    }
});

app.get('/internal/status', async (_req, res) => {
    try {
        res.json(await timed(getLog(res), 'mongo', 'find source status', getSourceStatuses));
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Failed to read status');
        res.status(503).json({ error: 'Canonical Store unavailable' });
    }
});

// P3-K6: Durable field-reports acceptance -> 202 Accepted before async relay/broker publish
app.post('/internal/field-reports', express.json({ limit: '256kb' }), async (req, res) => {
    const principal = req.header('x-client-id') || 'field-team';
    const idempotencyKey = req.header('idempotency-key') || undefined;
    const correlationId = req.header(CORRELATION_HEADER) || randomUUID();
    const traceparent = typeof res.locals.traceparent === 'string' ? res.locals.traceparent : req.header('traceparent');

    const result = await fieldReportOutbox.accept({
        body: req.body,
        principal,
        idempotencyKey,
        correlationId,
        traceparent,
    });

    if (result.status === 202) {
        setImmediate(() => void runOutboxRelay());
        res.status(202).json({
            status: 'accepted',
            report_id: result.report_id,
            hazard_id: result.hazard_id,
            duplicate: result.duplicate,
        });
        return;
    }
    if (result.status === 409) {
        res.status(409).json({ error: result.code, error_description: result.message });
        return;
    }
    if (result.status === 400) {
        res.status(400).json({ error: result.code, error_description: result.message });
        return;
    }
    res.status(503).json({ error: result.code, error_description: result.message });
});

// P3-K3: Direct bounded raw ingest for malformed payload resilience (truncated JSON, invalid UTF-8, deep nesting, oversized)
app.post('/internal/raw-ingest', express.raw({ type: '*/*', limit: MAX_PAYLOAD_BYTES * 4 }), async (req, res) => {
    const source = typeof req.query['source'] === 'string' && req.query['source'].length > 0 ? req.query['source'] : 'PVMBG';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? null));
    const parsed = parseBoundedRawJson(raw, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: MAX_JSON_DEPTH });

    if (!parsed.ok) {
        const stored = await rawInbox.appendFailure({
            source,
            raw,
            status: 'parked',
            retryable: false,
            reason: parsed.reason,
        });
        metrics.inc('aggregator_inbox_messages_total', { source, status: 'parked' });
        res.status(202).json({ status: 'quarantined', message_id: stored.message_id, reason: parsed.reason });
        return;
    }

    if (source === 'PVMBG') {
        const mapped = validateAndMapPvmbgRecord(parsed.value, schemaRules);
        if (!mapped.ok) {
            const stored = await rawInbox.appendFailure({
                source,
                source_ref_id: mapped.sourceRefId,
                raw,
                status: 'parked',
                retryable: false,
                reason: mapped.reason,
            });
            res.status(202).json({ status: 'quarantined', message_id: stored.message_id, reason: mapped.reason });
            return;
        }
        const r = await repo.ingest({ event: mapped.value as never, eventVersion: Date.parse(mapped.value.occurred_at) || undefined });
        res.status(200).json({ status: r.outcome, hazard_id: r.hazard_id });
        return;
    }

    res.status(400).json({ error: 'unsupported source for raw-ingest' });
});

// P3-K4 & K5: Internal Ops inspection, schema rule adjustment, and ordered replay
app.get('/internal/ops/unprocessed', async (req, res) => {
    const source = typeof req.query['source'] === 'string' && req.query['source'].length > 0 ? req.query['source'] : undefined;
    const cursor = typeof req.query['cursor'] === 'string' && req.query['cursor'].length > 0 ? req.query['cursor'] : undefined;
    const rawLimit = req.query['limit'];
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 1000' });
        return;
    }
    try {
        res.json(await rawInbox.list({ source, limit, cursor }));
    } catch (err) {
        if (err instanceof InvalidCursorError) {
            res.status(400).json({ error: 'invalid cursor' });
            return;
        }
        res.status(503).json({ error: 'Canonical Store unavailable' });
    }
});

app.post('/internal/ops/unprocessed/replay', express.json(), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = typeof body['source'] === 'string' && body['source'].length > 0 ? body['source'] : undefined;
    const reason = typeof body['reason'] === 'string' && body['reason'].length > 0 ? body['reason'] : undefined;
    const maxPerSec = typeof body['max_per_sec'] === 'number' && body['max_per_sec'] > 0 ? body['max_per_sec'] : REPLAY_MAX_PER_SEC;

    try {
        const stats = await rawInbox.replay({ source, reason }, processInboxRecord, maxPerSec, INBOX_MAX_ATTEMPTS);
        res.json(stats);
    } catch (err) {
        getLog(res).error({ error: errorMessage(err) }, 'Replay failed');
        res.status(503).json({ error: 'Replay failed due to storage error' });
    }
});

app.get('/internal/ops/schema-rules', (_req, res) => {
    res.json(schemaRules);
});

app.post('/internal/ops/schema-rules', express.json(), (req, res) => {
    const body = (req.body ?? {}) as Partial<SchemaRulesConfig>;
    schemaRules = {
        enablePvmbgV2Compat: body.enablePvmbgV2Compat ?? schemaRules.enablePvmbgV2Compat,
        fieldAliases: body.fieldAliases ?? (body.enablePvmbgV2Compat ? { mountain_code: 'volcano_id', status_level: 'alert_level' } : schemaRules.fieldAliases),
        coerceNumericStrings: body.coerceNumericStrings ?? (body.enablePvmbgV2Compat ?? schemaRules.coerceNumericStrings),
        defaults: body.defaults ?? schemaRules.defaults,
    };
    getLog(res).info({ schema_rules: schemaRules }, 'PVMBG schema rules updated by Internal Ops');
    res.json(schemaRules);
});

// ---- Audit API (:3001) --------------------------------------------------------------------------
const storageApp = express();
storageApp.use(metricsAndTracingMiddleware('aggregator-audit'));
storageApp.use(requestLogger);
storageApp.get('/metrics', metricsEndpoint);
storageApp.use(createStorageRouter({ repo, auditToken: process.env.AUDIT_TOKEN, unprocessed: rawInbox }));
const storageServer = storageApp.listen(STORAGE_API_PORT, () => {
    logger.info({ port: STORAGE_API_PORT }, 'Audit/analytics API started');
});

const server = app.listen(PORT, async () => {
    logger.info({ port: PORT, pod: POD_IDENTITY, polling_interval_ms: POLLING_INTERVAL }, 'Aggregator API started');

    try {
        await connectMongo();
        await Promise.all([rawInbox.ensureIndexes(), fieldReportOutbox.ensureIndexes()]);
    } catch (error) {
        logger.fatal({ error: errorMessage(error) }, 'Failed to connect to MongoDB');
        process.exit(1);
    }

    await initRabbitMQ();

    const leaseProvider = createLeaseProvider();
    bmkgLeader = new SourceLeaderManager({
        source: 'BMKG',
        leaseName: 'aggregator-poller-bmkg',
        identity: POD_IDENTITY,
        leaseDurationMs: LEASE_DURATION_MS,
        renewDeadlineMs: LEASE_RENEW_DEADLINE_MS,
        retryPeriodMs: LEASE_RETRY_PERIOD_MS,
        leaseProvider,
        fenceStore,
        logger,
        onLeadershipChange: ({ isLeader, epoch }) => {
            metrics.set('aggregator_is_leader', { source: 'BMKG' }, isLeader ? 1 : 0);
            metrics.set('aggregator_leader_epoch', { source: 'BMKG' }, epoch);
        },
    });
    pvmbgLeader = new SourceLeaderManager({
        source: 'PVMBG',
        leaseName: 'aggregator-poller-pvmbg',
        identity: POD_IDENTITY,
        leaseDurationMs: LEASE_DURATION_MS,
        renewDeadlineMs: LEASE_RENEW_DEADLINE_MS,
        retryPeriodMs: LEASE_RETRY_PERIOD_MS,
        leaseProvider,
        fenceStore,
        logger,
        onLeadershipChange: ({ isLeader, epoch }) => {
            metrics.set('aggregator_is_leader', { source: 'PVMBG' }, isLeader ? 1 : 0);
            metrics.set('aggregator_leader_epoch', { source: 'PVMBG' }, epoch);
        },
    });
    bmkgLeader.start();
    pvmbgLeader.start();

    const timers = [
        setInterval(pollBmkg, POLLING_INTERVAL),
        setInterval(pollPvmbg, POLLING_INTERVAL),
        setInterval(() => void runInboxRetryWorker(), 2000),
        setInterval(() => void runOutboxRelay(), 1000),
    ];

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, async () => {
            logger.info({ signal, pod: POD_IDENTITY }, 'aggregator draining and shutting down');
            shuttingDown = true;
            timers.forEach(clearInterval);
            await Promise.all([bmkgLeader?.stop(), pvmbgLeader?.stop()]);
            storageServer.close();
            server.close(async () => {
                await rabbitConnection?.close().catch(() => undefined);
                await closeMongo();
                process.exit(0);
            });
            setTimeout(() => process.exit(1), 15_000).unref();
        });
    }
});
