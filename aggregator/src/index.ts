import { randomUUID } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';
import type { Logger } from 'pino';

import { mapSeismicToHazard, mapVolcanicToHazard, pickStrongestWarning, recomputeSeverityFromWarning, warningRank, type HazardEvent } from './utils/mapper.js';
import { closeMongo, connectMongo, pingMongo } from './db/mongo.js';
import { upsertHazard, attachTsunamiWarning, markSourceSuccess, markSourceFailure, getSourceStatuses, findHazards, findHazardBySourceRef } from './db/hazardRepository.js';
import { CORRELATION_HEADER, errorMessage, getLog, logger, requestLogger, timed } from './logger.js';

const app = express();
app.use(requestLogger);
const PORT = process.env.AGGREGATOR_PORT || 3000;

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
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10); // 2-5s
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const EXCHANGE = 'hazard_events';
const RECONNECT_DELAY_MS = 5000;
const MAX_PENDING_PUBLISH = 10_000;

// Each source has its own cursor and its own "running" flag, so a slow source never holds back the other
let lastFetchBMKG = new Date(0).toISOString();
let lastFetchPVMBG = new Date(0).toISOString();
const polling = { BMKG: false, PVMBG: false };

let rabbitChannel: amqp.ConfirmChannel | undefined;
let rabbitConnection: amqp.ChannelModel | undefined;
let shuttingDown = false;

interface PendingPublish {
    event: HazardEvent;
    correlationId: string;
}
// Events that could not be published (broker down or message not confirmed) wait here and are sent after reconnect.
// In memory only: they are lost if the Aggregator itself restarts while the broker is down.
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
    const { event, correlationId } = item;
    try {
        channel.publish(
            EXCHANGE,
            '',
            Buffer.from(JSON.stringify(event)),
            {
                contentType: 'application/json',
                // A severity update of the same hazard is a different message from the original event
                messageId: `${event.hazard_id}:${event.severity}`,
                correlationId,
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

function flushPendingPublish(): void {
    if (pendingPublish.length === 0) return;
    const items = pendingPublish;
    pendingPublish = [];
    logger.info({ count: items.length }, 'Publishing buffered HazardEvents');
    for (const item of items) sendToBroker(item, logger.child({ correlation_id: item.correlationId }));
}

async function initRabbitMQ(): Promise<void> {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        // A confirm channel tells us whether the broker really accepted each message
        const channel = await connection.createConfirmChannel();
        await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });

        connection.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'RabbitMQ connection error'));
        connection.on('close', () => {
            rabbitChannel = undefined;
            rabbitConnection = undefined;
            if (shuttingDown) return;
            logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'RabbitMQ connection lost');
            setTimeout(initRabbitMQ, RECONNECT_DELAY_MS);
        });

        rabbitConnection = connection;
        rabbitChannel = channel;
        logger.info('Connected to RabbitMQ');
        flushPendingPublish();
    } catch (error) {
        logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Failed to connect to RabbitMQ');
        setTimeout(initRabbitMQ, RECONNECT_DELAY_MS);
    }
}

async function fetchBMKG(log: Logger, correlationId: string) {
    const headers = { 'X-BMKG-Key': X_BMKG_KEY, [CORRELATION_HEADER]: correlationId };
    const [eventsRes, warningsRes] = await Promise.all([
        timed(log, 'bmkg', 'GET /seismic-events', () =>
            axios.get(`${BMKG_URL}/seismic-events?since=${lastFetchBMKG}`, { headers, timeout: 2000 })
        ),
        timed(log, 'bmkg', 'GET /tsunami-warnings', () =>
            axios.get(`${BMKG_URL}/tsunami-warnings?since=${lastFetchBMKG}`, { headers, timeout: 2000 })
        ),
    ]);

    return { events: eventsRes.data as any[], warnings: warningsRes.data as any[] };
}

async function fetchPVMBG(log: Logger, correlationId: string) {
    const res = await timed(log, 'pvmbg', 'GET /volcanic-reports', () =>
        axios.get(`${PVMBG_URL}/volcanic-reports?since=${lastFetchPVMBG}`, {
            headers: { Authorization: `Bearer ${PVMBG_TOKEN}`, [CORRELATION_HEADER]: correlationId },
            timeout: 5000,
        })
    );
    return res.data as any[];
}

// Saves every hazard first, then publishes only the newly inserted ones (a re-fetched record is not announced twice).
// Returns true when every record was saved.
async function saveAndPublish(hazards: HazardEvent[], log: Logger, correlationId: string): Promise<boolean> {
    const inserted: HazardEvent[] = [];
    let allSaved = true;
    const start = performance.now();

    for (const hazard of hazards) {
        try {
            if (await upsertHazard(hazard)) inserted.push(hazard);
        } catch (error) {
            allSaved = false;
            log.error({ source_ref_id: hazard.source_ref_id, error: errorMessage(error) }, 'Failed to save HazardEvent');
        }
    }
    if (hazards.length > 0) {
        log.info(
            { target: 'mongo', call: 'upsert hazards', count: hazards.length, inserted: inserted.length, duration_ms: Math.round(performance.now() - start) },
            'outgoing call ok'
        );
    }

    for (const event of inserted) sendToBroker({ event, correlationId }, log);
    return allSaved;
}

// A tsunami warning can be issued after its event was already stored. Warnings whose event is not in this batch
// are applied to the stored event, and the change is announced again when the severity changes.
// The strongest warning wins: a later, weaker warning never lowers the severity.
async function applyLateWarnings(events: any[], warnings: any[], log: Logger, correlationId: string): Promise<void> {
    const batchEventIds = new Set(events.map((e) => e.event_id));
    const lateEventIds = new Set<string>();
    for (const w of warnings) {
        if (typeof w?.related_event_id === 'string' && !batchEventIds.has(w.related_event_id)) lateEventIds.add(w.related_event_id);
    }

    for (const eventId of lateEventIds) {
        try {
            const stored = await findHazardBySourceRef('BMKG', eventId);
            // Not stored yet: the next poll returns this warning again together with its event
            if (!stored) continue;

            const w = pickStrongestWarning(warnings, eventId);
            const current = stored.attributes.tsunami_warning;
            if (current !== undefined && warningRank(current) >= warningRank(w)) continue;

            const newSeverity = recomputeSeverityFromWarning(w);
            if (!(await attachTsunamiWarning(stored.hazard_id, newSeverity, w))) continue;
            log.info(
                { hazard_id: stored.hazard_id, old_severity: stored.severity, new_severity: newSeverity },
                'Late tsunami warning applied to stored event'
            );
            if (newSeverity !== stored.severity) {
                const event = { ...stored, severity: newSeverity, attributes: { ...stored.attributes, tsunami_warning: w } };
                sendToBroker({ event, correlationId }, log);
            }
        } catch (error) {
            log.error({ related_event_id: eventId, error: errorMessage(error) }, 'Failed to apply late warning');
        }
    }
}

// Lets the Client API flag a source as stale right after the first failed poll, without waiting for a timeout
async function recordFailure(source: 'BMKG' | 'PVMBG', log: Logger): Promise<void> {
    try {
        await markSourceFailure(source);
    } catch (error) {
        log.error({ error: errorMessage(error) }, 'Failed to record source failure');
    }
}

async function pollBmkg(): Promise<void> {
    const correlationId = `poll-${randomUUID()}`;
    const log = logger.child({ correlation_id: correlationId, source: 'BMKG' });

    if (polling.BMKG) {
        log.warn('Previous BMKG poll still running, skipping this tick');
        return;
    }
    polling.BMKG = true;

    try {
        const fetchTime = new Date().toISOString();

        let data: Awaited<ReturnType<typeof fetchBMKG>>;
        try {
            data = await fetchBMKG(log, correlationId);
        } catch (error) {
            log.error({ error: errorMessage(error) }, 'Failed to fetch BMKG data');
            await recordFailure('BMKG', log);
            return;
        }
        const { events, warnings } = data;

        // Each record in its own try/catch, so one bad record does not stall the whole poll
        const newHazards: HazardEvent[] = [];
        for (const raw of events) {
            try {
                const relatedWarning = pickStrongestWarning(warnings, raw.event_id);
                newHazards.push(mapSeismicToHazard(raw, relatedWarning));
            } catch (error) {
                log.error({ event_id: raw?.event_id, error: errorMessage(error) }, 'Skipping malformed seismic record');
            }
        }

        await applyLateWarnings(events, warnings, log, correlationId);

        // The cursor only moves forward when everything was saved, otherwise the next poll retries the same window
        if (await saveAndPublish(newHazards, log, correlationId)) {
            lastFetchBMKG = fetchTime;
            await markSourceSuccess('BMKG');
        }
    } catch (error) {
        log.error({ error: errorMessage(error) }, 'BMKG poll failed');
    } finally {
        polling.BMKG = false;
    }
}

async function pollPvmbg(): Promise<void> {
    const correlationId = `poll-${randomUUID()}`;
    const log = logger.child({ correlation_id: correlationId, source: 'PVMBG' });

    if (polling.PVMBG) {
        log.warn('Previous PVMBG poll still running, skipping this tick');
        return;
    }
    polling.PVMBG = true;

    try {
        const fetchTime = new Date().toISOString();

        let reports: any[];
        try {
            reports = await fetchPVMBG(log, correlationId);
        } catch (error) {
            log.warn({ error: errorMessage(error) }, 'PVMBG did not respond (outage / timeout)');
            await recordFailure('PVMBG', log);
            return;
        }

        // Unknown fields go to attributes. A missing or unknown alert_level is skipped and logged, it must not stall ingestion
        const newHazards: HazardEvent[] = [];
        for (const raw of reports) {
            try {
                newHazards.push(mapVolcanicToHazard(raw));
            } catch (error) {
                log.error({ report_id: raw?.report_id, error: errorMessage(error) }, 'Skipping malformed volcanic record');
            }
        }

        if (await saveAndPublish(newHazards, log, correlationId)) {
            lastFetchPVMBG = fetchTime;
            await markSourceSuccess('PVMBG');
        }
    } catch (error) {
        log.error({ error: errorMessage(error) }, 'PVMBG poll failed');
    } finally {
        polling.PVMBG = false;
    }
}

app.get('/health', async (req, res) => {
    const storeConnected = await pingMongo(1000);
    res.status(storeConnected ? 200 : 503).json({
        status: storeConnected ? 'ok' : 'degraded',
        service: 'aggregator',
        store_connected: storeConnected,
        broker_connected: rabbitChannel !== undefined,
    });
});

const HAZARD_TYPES = ['SEISMIC', 'VOLCANIC'] as const;
const SEVERITIES = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'] as const;
const SOURCES = ['BMKG', 'PVMBG'] as const;

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    return null;
}

app.get('/internal/events', async (req, res) => {
    const hazard_type = parseEnum(req.query.hazard_type, HAZARD_TYPES);
    const severity = parseEnum(req.query.severity, SEVERITIES);
    const source = parseEnum(req.query.source, SOURCES);
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
        const events = await timed(getLog(res), 'mongo', 'find hazards', () =>
            findHazards({ hazard_type, severity, source, since }, limit)
        );
        res.json({ events });
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Failed to read events');
        res.status(503).json({ error: 'Canonical Store unavailable' });
    }
});

app.get('/internal/status', async (req, res) => {
    try {
        res.json(await timed(getLog(res), 'mongo', 'find source status', getSourceStatuses));
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Failed to read status');
        res.status(503).json({ error: 'Canonical Store unavailable' });
    }
});

const server = app.listen(PORT, async () => {
    logger.info({ port: PORT, polling_interval_ms: POLLING_INTERVAL }, 'Aggregator API started');

    try {
        await connectMongo();
    } catch (error) {
        logger.fatal({ error: errorMessage(error) }, 'Failed to connect to MongoDB');
        process.exit(1);
    }

    await initRabbitMQ();

    const pollers = [setInterval(pollBmkg, POLLING_INTERVAL), setInterval(pollPvmbg, POLLING_INTERVAL)];

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            logger.info({ signal }, 'aggregator shutting down');
            shuttingDown = true;
            pollers.forEach(clearInterval);
            server.close(async () => {
                await rabbitConnection?.close().catch(() => undefined);
                await closeMongo();
                process.exit(0);
            });
            setTimeout(() => process.exit(1), 8000).unref();
        });
    }
});
