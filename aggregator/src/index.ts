import { randomUUID } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';
import type { Logger } from 'pino';

import { mapSeismicToHazard, mapVolcanicToHazard, type HazardEvent } from './utils/mapper.js';
import { closeMongo, connectMongo, pingMongo } from './db/mongo.js';
import { upsertHazard, markSourceSuccess, getSourceStatuses, findHazards } from './db/hazardRepository.js';
import { CORRELATION_HEADER, errorMessage, getLog, logger, requestLogger, timed } from './logger.js';

const app = express();
app.use(requestLogger);
const PORT = process.env.AGGREGATOR_PORT || 3000;

const BMKG_URL = process.env.BMKG_URL || 'http://localhost:8081';
const PVMBG_URL = process.env.PVMBG_URL || 'http://localhost:8082';
const X_BMKG_KEY = process.env.X_BMKG_KEY;
const PVMBG_TOKEN = process.env.PVMBG_TOKEN;
if (!X_BMKG_KEY || !/^bmkg_[0-9a-f]{64}$/.test(X_BMKG_KEY)) {
    logger.fatal('X_BMKG_KEY wajib diisi dengan format bmkg_<64 hex>');
    process.exit(1);
}
if (!PVMBG_TOKEN || !/^pvmbg\.v1\.[A-Za-z0-9_-]{43}$/.test(PVMBG_TOKEN)) {
    logger.fatal('PVMBG_TOKEN wajib diisi dengan format pvmbg.v1.<43 karakter base64url>');
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

        connection.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'koneksi RabbitMQ error'));
        connection.on('close', () => {
            rabbitChannel = undefined;
            rabbitConnection = undefined;
            if (shuttingDown) return;
            logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'koneksi RabbitMQ terputus');
            setTimeout(initRabbitMQ, RECONNECT_DELAY_MS);
        });

        rabbitConnection = connection;
        rabbitChannel = channel;
        logger.info('Berhasil terhubung ke RabbitMQ');
    } catch (error) {
        logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Gagal terhubung ke RabbitMQ');
        setTimeout(initRabbitMQ, RECONNECT_DELAY_MS);
    }
}

async function fetchBMKG(log: Logger, correlationId: string) {
    const headers = { 'X-BMKG-Key': X_BMKG_KEY, [CORRELATION_HEADER]: correlationId };
    const eventsRes = await timed(log, 'bmkg', 'GET /seismic-events', () =>
        axios.get(`${BMKG_URL}/seismic-events?since=${lastFetchBMKG}`, { headers, timeout: 2000 })
    );
    const warningsRes = await timed(log, 'bmkg', 'GET /tsunami-warnings', () =>
        axios.get(`${BMKG_URL}/tsunami-warnings`, { headers, timeout: 2000 })
    );

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
        log.warn('Poll sebelumnya masih berjalan, tick ini dilewati');
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

        // Proses Data BMKG
        if (bmkgResult.status === 'fulfilled') {
            const { events, warnings } = bmkgResult.value;
            events.forEach((raw: any) => {
                const relatedWarning = warnings.find((w: any) => w.related_event_id === raw.event_id);
                newHazards.push(mapSeismicToHazard(raw, relatedWarning));
            });
            bmkgFetched = true;
        } else {
            log.error({ error: errorMessage(bmkgResult.reason) }, 'Gagal mengambil data BMKG');
        }

        // Proses Data PVMBG
        if (pvmbgResult.status === 'fulfilled') {
            const reports = pvmbgResult.value;
            reports.forEach((raw: any) => {
                newHazards.push(mapVolcanicToHazard(raw));
            });
            pvmbgFetched = true;
        } else {
            log.warn({ error: errorMessage(pvmbgResult.reason) }, 'PVMBG tidak merespons (Outage / Timeout)');
        }

        // Save ke MongoDB
        const inserted: HazardEvent[] = [];
        let saveFailed = false;
        const saveStart = performance.now();
        for (const hazard of newHazards) {
            try {
                if (await upsertHazard(hazard)) inserted.push(hazard);
            } catch (error) {
                saveFailed = true;
                log.error({ source_ref_id: hazard.source_ref_id, error: errorMessage(error) }, 'Gagal menyimpan HazardEvent');
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

        // Publish ke RabbitMQ
        const channel = rabbitChannel;
        if (channel) {
            inserted.forEach(hazard => {
                const message = Buffer.from(JSON.stringify(hazard));
                channel.publish(EXCHANGE, '', message, {
                    contentType: 'application/json',
                    messageId: hazard.hazard_id,
                    correlationId,
                });
                log.info({ hazard_id: hazard.hazard_id, source: hazard.source, severity: hazard.severity }, 'Mempublikasikan HazardEvent');
            });
        } else if (inserted.length > 0) {
            log.warn({ skipped: inserted.length }, 'RabbitMQ belum terhubung, HazardEvent tidak dipublikasikan');
        }
    } catch (error) {
        log.error({ error: errorMessage(error) }, 'Poll gagal');
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
        res.status(400).json({ error: 'hazard_type, severity, atau source tidak valid' });
        return;
    }

    let since: string | undefined;
    const sinceParam = req.query.since;
    if (sinceParam !== undefined) {
        if (typeof sinceParam !== 'string' || Number.isNaN(Date.parse(sinceParam))) {
            res.status(400).json({ error: 'since harus berupa tanggal ISO 8601' });
            return;
        }
        since = new Date(sinceParam).toISOString();
    }

    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ error: 'limit harus bilangan bulat >= 1' });
        return;
    }

    try {
        const events = await timed(getLog(res), 'mongo', 'find hazards', () =>
            findHazards({ hazard_type, severity, source, since }, limit)
        );
        res.json({ events });
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Gagal membaca events');
        res.status(503).json({ error: 'Canonical Store tidak tersedia' });
    }
});

app.get('/internal/status', async (req, res) => {
    try {
        res.json(await timed(getLog(res), 'mongo', 'find source status', getSourceStatuses));
    } catch (error) {
        getLog(res).error({ error: errorMessage(error) }, 'Gagal membaca status');
        res.status(503).json({ error: 'Canonical Store tidak tersedia' });
    }
});

const server = app.listen(PORT, async () => {
    logger.info({ port: PORT, polling_interval_ms: POLLING_INTERVAL }, 'Aggregator API berjalan');

    try {
        await connectMongo();
    } catch (error) {
        logger.fatal({ error: errorMessage(error) }, 'Gagal terhubung ke MongoDB');
        process.exit(1);
    }

    await initRabbitMQ();

    const poller = setInterval(pollData, POLLING_INTERVAL);

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            logger.info({ signal }, 'aggregator berhenti');
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
