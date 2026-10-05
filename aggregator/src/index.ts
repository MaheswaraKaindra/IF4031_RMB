import { randomUUID } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';
import type { Logger } from 'pino';

import { mapSeismicToHazard, mapVolcanicToHazard, recomputeSeverityFromWarning, type HazardEvent } from './utils/mapper.js';
import { closeMongo, connectMongo, pingMongo } from './db/mongo.js';
import { upsertHazard, updateHazardSeverity, markSourceSuccess, getSourceStatuses, findHazards, findHazardBySourceRef } from './db/hazardRepository.js';
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

let lastFetchBMKG = new Date(0).toISOString();
let lastFetchPVMBG = new Date(0).toISOString();
let isPolling = false;
let rabbitChannel: amqp.Channel | undefined;
let rabbitConnection: amqp.ChannelModel | undefined;
let shuttingDown = false;

async function initRabbitMQ(): Promise<void> {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
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
    } catch (error) {
        logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Failed to connect to RabbitMQ');
        setTimeout(initRabbitMQ, RECONNECT_DELAY_MS);
    }
}

async function fetchBMKG(log: Logger, correlationId: string) {
    const headers = { 'X-BMKG-Key': X_BMKG_KEY, [CORRELATION_HEADER]: correlationId };
    // Run both sub-calls in parallel; each has its own timeout
    const [eventsRes, warningsRes] = await Promise.all([
        timed(log, 'bmkg', 'GET /seismic-events', () =>
            axios.get(`${BMKG_URL}/seismic-events?since=${lastFetchBMKG}`, { headers, timeout: 2000 })
        ),
        timed(log, 'bmkg', 'GET /tsunami-warnings', () =>
            // Pass since so the mock (and real API) only returns new/updated warnings
            axios.get(`${BMKG_URL}/tsunami-warnings?since=${lastFetchBMKG}`, { headers, timeout: 2000 })
        ),
    ]);

    return { events: eventsRes.data, warnings: warningsRes.data };
}

async function fetchPVMBG(log: Logger, correlationId: string) {
    const res = await timed(log, 'pvmbg', 'GET /volcanic-reports', () =>
        axios.get(`${PVMBG_URL}/volcanic-reports?since=${lastFetchPVMBG}`, {
            headers: { Authorization: `Bearer ${PVMBG_TOKEN}`, [CORRELATION_HEADER]: correlationId },
            timeout: 5000,
        })
    );
    return res.data;
}

async function pollData() {
    const correlationId = `poll-${randomUUID()}`;
    const log = logger.child({ correlation_id: correlationId });

    if (isPolling) {
        log.warn('Previous poll still running, skipping this tick');
        return;
    }
    isPolling = true;

    try {
        const fetchTime = new Date().toISOString();

        const [bmkgResult, pvmbgResult] = await Promise.allSettled([
            fetchBMKG(log, correlationId),
            fetchPVMBG(log, correlationId)
        ]);

        const newHazards: HazardEvent[] = [];
        let bmkgFetched = false;
        let pvmbgFetched = false;

        // Process BMKG data
        if (bmkgResult.status === 'fulfilled') {
            const { events, warnings } = bmkgResult.value;

            // Map new seismic events (each in its own try/catch so one bad record doesn't stall the cycle)
            events.forEach((raw: any) => {
                try {
                    const relatedWarning = warnings.find((w: any) => w.related_event_id === raw.event_id);
                    newHazards.push(mapSeismicToHazard(raw, relatedWarning));
                } catch (err) {
                    log.error({ event_id: raw?.event_id, error: errorMessage(err) }, 'Skipping malformed seismic record');
                }
            });

            // Apply late warnings to events that are already stored
            // (warnings whose related_event_id does not appear in the current batch)
            const newEventIds = new Set(events.map((e: any) => e.event_id));
            for (const w of warnings) {
                if (newEventIds.has(w.related_event_id)) continue; // handled above
                try {
                    const stored = await findHazardBySourceRef('BMKG', w.related_event_id);
                    if (!stored) continue;
                    const newSeverity = recomputeSeverityFromWarning(w);
                    if (newSeverity === stored.severity) continue;
                    const updated = await updateHazardSeverity(stored.hazard_id, newSeverity, w);
                    if (updated) {
                        log.info(
                            { hazard_id: stored.hazard_id, old_severity: stored.severity, new_severity: newSeverity },
                            'Late warning applied to stored event'
                        );
                        // Re-publish with updated severity
                        const channel = rabbitChannel;
                        if (channel) {
                            const updatedEvent = { ...stored, severity: newSeverity, attributes: { ...stored.attributes, tsunami_warning: w } };
                            channel.publish(EXCHANGE, '', Buffer.from(JSON.stringify(updatedEvent)), {
                                contentType: 'application/json',
                                messageId: stored.hazard_id,
                                correlationId,
                                persistent: true,
                            });
                        }
                    }
                } catch (err) {
                    log.error({ related_event_id: w?.related_event_id, error: errorMessage(err) }, 'Failed to apply late warning');
                }
            }

            bmkgFetched = true;
        } else {
            log.error({ error: errorMessage(bmkgResult.reason) }, 'Failed to fetch BMKG data');
        }

        // Process PVMBG data
        if (pvmbgResult.status === 'fulfilled') {
            const reports = pvmbgResult.value;
            reports.forEach((raw: any) => {
                // Each record in its own try/catch — a missing/bad alert_level must not stall ingestion
                try {
                    newHazards.push(mapVolcanicToHazard(raw));
                } catch (err) {
                    log.error({ report_id: raw?.report_id, error: errorMessage(err) }, 'Skipping malformed volcanic record');
                }
            });
            pvmbgFetched = true;
        } else {
            log.warn({ error: errorMessage(pvmbgResult.reason) }, 'PVMBG did not respond (outage / timeout)');
        }

        // Save to MongoDB
        const inserted: HazardEvent[] = [];
        let saveFailed = false;
        const saveStart = performance.now();
        for (const hazard of newHazards) {
            try {
                if (await upsertHazard(hazard)) inserted.push(hazard);
            } catch (error) {
                saveFailed = true;
                log.error({ source_ref_id: hazard.source_ref_id, error: errorMessage(error) }, 'Failed to save HazardEvent');
            }
        }
        if (newHazards.length > 0) {
            log.info(
                { target: 'mongo', call: 'upsert hazards', count: newHazards.length, inserted: inserted.length, duration_ms: Math.round(performance.now() - saveStart) },
                'outgoing call ok'
            );
        }

        if (!saveFailed) {
            if (bmkgFetched) {
                lastFetchBMKG = fetchTime;
                await markSourceSuccess('BMKG');
            }
            if (pvmbgFetched) {
                lastFetchPVMBG = fetchTime;
                await markSourceSuccess('PVMBG');
            }
        }

        // Publish to RabbitMQ
        const channel = rabbitChannel;
        if (channel) {
            inserted.forEach(hazard => {
                const message = Buffer.from(JSON.stringify(hazard));
                channel.publish(EXCHANGE, '', message, {
                    contentType: 'application/json',
                    messageId: hazard.hazard_id,
                    correlationId,
                    // persistent:true ensures messages survive a broker restart (P5 delivery semantics)
                    persistent: true,
                });
                log.info({ hazard_id: hazard.hazard_id, source: hazard.source, severity: hazard.severity }, 'Published HazardEvent');
            });
        } else if (inserted.length > 0) {
            log.warn({ skipped: inserted.length }, 'RabbitMQ not connected, HazardEvents not published');
        }
    } catch (error) {
        log.error({ error: errorMessage(error) }, 'Poll failed');
    } finally {
        isPolling = false;
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

    const poller = setInterval(pollData, POLLING_INTERVAL);

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            logger.info({ signal }, 'aggregator shutting down');
            shuttingDown = true;
            clearInterval(poller);
            server.close(async () => {
                await rabbitConnection?.close().catch(() => undefined);
                await closeMongo();
                process.exit(0);
            });
            setTimeout(() => process.exit(1), 8000).unref();
        });
    }
});
