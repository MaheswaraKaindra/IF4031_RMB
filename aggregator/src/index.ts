import express from 'express';
import axios from 'axios';
import amqp from 'amqplib';

import { mapSeismicToHazard, mapVolcanicToHazard, type HazardEvent } from './utils/mapper.js';

const app = express();
const PORT = process.env.AGGREGATOR_PORT || 3000;

const BMKG_URL = process.env.BMKG_URL || 'http://localhost:8081';
const PVMBG_URL = process.env.PVMBG_URL || 'http://localhost:8082';
const X_BMKG_KEY = process.env.X_BMKG_KEY;
const PVMBG_TOKEN = process.env.PVMBG_TOKEN;
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS || '3000', 10); // 2-5s
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

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

        // Proses Data BMKG
        if (bmkgResult.status === 'fulfilled') {
            const { events, warnings } = bmkgResult.value;
            events.forEach((raw: any) => {
                const relatedWarning = warnings.find((w: any) => w.related_event_id === raw.event_id);
                newHazards.push(mapSeismicToHazard(raw, relatedWarning));
            });
            lastFetchBMKG = fetchTime;
        } else {
            console.error('Gagal mengambil data BMKG:', bmkgResult.reason.message);
        }

        // Proses Data PVMBG
        if (pvmbgResult.status === 'fulfilled') {
            const reports = pvmbgResult.value;
            reports.forEach((raw: any) => {
                newHazards.push(mapVolcanicToHazard(raw));
            });
            lastFetchPVMBG = fetchTime;
        } else {
            console.warn('PVMBG tidak merespons (Outage / Timeout):', pvmbgResult.reason.message);
        }

        if (newHazards.length > 0 && rabbitChannel) {
            newHazards.forEach(hazard => {
                const message = Buffer.from(JSON.stringify(hazard));
                rabbitChannel.publish('hazard_events', '', message);
                console.log(`[x] Mempublikasikan HazardEvent: ${hazard.hazard_id}`);
            });

            // WOI NUT @0xNathaniel
            // Di bagian ini nantinya fungsi penyisipan ke MongoDB
            // cmn Aggregator hrsnya yg konek ke DB
        }
    } catch (error) {
        console.error('Poll gagal:', error instanceof Error ? error.message : String(error));
    } finally {
        isPolling = false;
    }
}

app.get('/health', (req, res) => res.status(200).send('Aggregator Sehat'));

app.listen(PORT, async () => {
    console.log(`Aggregator API berjalan di port ${PORT}`);
    await initRabbitMQ();
    
    setInterval(pollData, POLLING_INTERVAL);
});