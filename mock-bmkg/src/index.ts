// App's Entry Point

import express, { Request, Response, NextFunction } from 'express';

const app = express();
const PORT = process.env.BMKG_PORT || 8081;
const API_KEY = process.env.X_BMKG_KEY;

const EVENT_INTERVAL_MS = parseInt(process.env.BMKG_EVENT_INTERVAL_MS || '10000', 10); // new event every 10s (spec minimum)

function createSeismicEvent(n: number, occurredAt: Date) {
    return {
        event_id: `EV-BMKG-${1000 + n}`,
        magnitude: +(Math.random() * (7.5 - 3.0) + 3.0).toFixed(1),
        depth_km: +(Math.random() * 50 + 10).toFixed(1),
        epicenter_lat: -8.5 + Math.random(),
        epicenter_lon: 110.0 + Math.random(),
        region_name: `Wilayah Pesisir ${n}`,
        occurred_at: occurredAt.toISOString(),
        potential_tsunami: n % 5 === 0
    };
}

function createTsunamiWarning(ev: ReturnType<typeof createSeismicEvent>) {
    return {
        warning_id: `WARN-${ev.event_id}`,
        related_event_id: ev.event_id,
        threat_level: ev.magnitude >= 6.5 ? 'Awas' : (ev.magnitude >= 5.0 ? 'Siaga' : 'Waspada'),
        affected_zones: [ev.region_name, 'Pesisi Sekitarnya'],
        estimated_arrival: new Date(new Date(ev.occurred_at).getTime() + 1800000).toISOString()
    };
}

const seismicEvents = Array.from({ length: 20 }).map((_, i) =>
    createSeismicEvent(i, new Date(Date.now() - i * 3600000))
);

const tsunamiWarnings = seismicEvents
    .filter(ev => ev.potential_tsunami)
    .map(createTsunamiWarning);

let nextEventNumber = seismicEvents.length;
setInterval(() => {
    const ev = createSeismicEvent(nextEventNumber++, new Date());
    seismicEvents.push(ev);
    if (ev.potential_tsunami) tsunamiWarnings.push(createTsunamiWarning(ev));
}, EVENT_INTERVAL_MS);

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();
    
    if (req.headers['x-bmkg-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Kredensial tidak valid' });
    }
    
    const delay = Math.floor(Math.random() * 100) + 50; // 50-150 ms
    setTimeout(next, delay);
});

app.get('/health', (req: Request, res: Response) => res.status(200).send('OK'));

app.get('/seismic-events', (req: Request, res: Response) => {
    const since = req.query.since ? new Date(req.query.since as string) : new Date(0);
    const filtered = seismicEvents.filter(ev => new Date(ev.occurred_at) >= since);
    res.json(filtered);
});

app.get('/tsunami-warnings', (req: Request, res: Response) => {
    // Implementasi filter since jika diperlukan
    res.json(tsunamiWarnings);
});

app.listen(PORT, () => console.log(`Mock BMKG berjalan di port ${PORT}`));