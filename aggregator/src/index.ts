import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';

import { mapSeismicToHazard, mapVolcanicToHazard, type HazardEvent } from './utils/mapper.js';
import { connectMongo } from './db/mongo.js';
import { upsertHazard, markSourceSuccess, getSourceStatuses, findHazards } from './db/hazardRepository.js';

const app = express();
const PORT = process.env.AGGREGATOR_PORT || 3000;

const BMKG_URL = process.env.BMKG_URL || 'http://localhost:8081';
const PVMBG_URL = process.env.PVMBG_URL || 'http://localhost:8082';
const X_BMKG_KEY = process.env.X_BMKG_KEY;
const PVMBG_TOKEN = process.env.PVMBG_TOKEN;
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10); // 2-5s
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

let lastFetchBMKG = new Date(0).toISOString();
let lastFetchPVMBG = new Date(0).toISOString();
let isPolling = false;
let rabbitChannel: amqp.Channel;


async function initRabbitMQ() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        await rabbitChannel.assertExchange('hazard_events', 'fanout', { durable: true });
        console.log('[Aggregator] Berhasil terhubung ke RabbitMQ');
    } catch (error) {
        console.error('[Aggregator] Gagal terhubung ke RabbitMQ:', error);
    }
}

async function fetchBMKG() {
    const eventsRes = await axios.get(`${BMKG_URL}/seismic-events?since=${lastFetchBMKG}`, {
        headers: { 'X-BMKG-Key': X_BMKG_KEY },
        timeout: 2000
    });
    
    const warningsRes = await axios.get(`${BMKG_URL}/tsunami-warnings`, {
        headers: { 'X-BMKG-Key': X_BMKG_KEY }
    });

    return { events: eventsRes.data, warnings: warningsRes.data };
}

async function fetchPVMBG() {
    const res = await axios.get(`${PVMBG_URL}/volcanic-reports?since=${lastFetchPVMBG}`, {
        headers: { 'Authorization': `Bearer ${PVMBG_TOKEN}` },
        timeout: 5000
    });
    return res.data;
}

async function pollData() {
    if (isPolling) {
        console.warn('Poll sebelumnya masih berjalan, tick ini dilewati');
        return;
    }
    isPolling = true;

    try {
        const fetchTime = new Date().toISOString();

        const [bmkgResult, pvmbgResult] = await Promise.allSettled([
            fetchBMKG(),
            fetchPVMBG()
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
            console.error('Gagal mengambil data BMKG:', bmkgResult.reason.message);
        }

        // Proses Data PVMBG
        if (pvmbgResult.status === 'fulfilled') {
            const reports = pvmbgResult.value;
            reports.forEach((raw: any) => {
                newHazards.push(mapVolcanicToHazard(raw));
            });
            pvmbgFetched = true;
        } else {
            console.warn('PVMBG tidak merespons (Outage / Timeout):', pvmbgResult.reason.message);
        }

        // Save ke MongoDB
        const inserted: HazardEvent[] = [];
        let saveFailed = false;
        for (const hazard of newHazards) {
            try {
                if (await upsertHazard(hazard)) inserted.push(hazard);
            } catch (error) {
                saveFailed = true;
                console.error(`Gagal menyimpan HazardEvent ${hazard.source_ref_id}:`, error instanceof Error ? error.message : String(error));
            }
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
        if (rabbitChannel) {
            inserted.forEach(hazard => {
                const message = Buffer.from(JSON.stringify(hazard));
                rabbitChannel.publish('hazard_events', '', message);
                console.log(`Mempublikasikan HazardEvent: ${hazard.hazard_id}`);
            });
        }
    } catch (error) {
        console.error('Poll gagal:', error instanceof Error ? error.message : String(error));
    } finally {
        isPolling = false;
    }
}

app.get('/health', (req, res) => res.status(200).send('Aggregator Sehat'));

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
        const events = await findHazards({ hazard_type, severity, source, since }, limit);
        res.json({ events });
    } catch (error) {
        console.error('Gagal membaca events:', error instanceof Error ? error.message : String(error));
        res.status(503).json({ error: 'Canonical Store tidak tersedia' });
    }
});

app.get('/internal/status', async (req, res) => {
    try {
        res.json(await getSourceStatuses());
    } catch (error) {
        console.error('Gagal membaca status:', error instanceof Error ? error.message : String(error));
        res.status(503).json({ error: 'Canonical Store tidak tersedia' });
    }
});

app.listen(PORT, async () => {
    console.log(`Aggregator API berjalan di port ${PORT}`);

    try {
        await connectMongo();
    } catch (error) {
        console.error('Gagal terhubung ke MongoDB:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    await initRabbitMQ();

    setInterval(pollData, POLLING_INTERVAL);
});