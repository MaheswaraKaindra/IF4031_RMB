import { createServer } from 'node:http';
import amqp from 'amqplib';
import pino, { type Logger } from 'pino';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8095', 10);
const EXCHANGE = 'hazard_events';
const RECONNECT_DELAY_MS = 5000;

export interface ConsumerOptions {
    service: string;
    queue: string;
    handle: (event: any, log: Logger) => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function runConsumer({ service, queue, handle }: ConsumerOptions): void {
    const logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        base: { service },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level: (label) => ({ level: label }),
        },
    });

    let connection: amqp.ChannelModel | undefined;
    let shuttingDown = false;

    async function connect(): Promise<void> {
        try {
            const conn = await amqp.connect(RABBITMQ_URL);
            const channel = await conn.createChannel();

            await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });
            const q = await channel.assertQueue(queue, { durable: true });
            await channel.bindQueue(q.queue, EXCHANGE, '');

            conn.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'koneksi RabbitMQ error'));
            conn.on('close', () => {
                connection = undefined;
                if (shuttingDown) return;
                logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'koneksi RabbitMQ terputus');
                setTimeout(connect, RECONNECT_DELAY_MS);
            });
            connection = conn;

            logger.info({ queue: q.queue }, 'Menunggu event');

            await channel.consume(q.queue, (msg) => {
                if (msg === null) return;
                const log = logger.child({ correlation_id: msg.properties.correlationId });
                handle(JSON.parse(msg.content.toString()), log);
                channel.ack(msg);
            });
        } catch (error) {
            logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Gagal terhubung ke RabbitMQ');
            setTimeout(connect, RECONNECT_DELAY_MS);
        }
    }

    const health = createServer((req, res) => {
        if (req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        const connected = connection !== undefined;
        res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: connected ? 'ok' : 'degraded', service, broker_connected: connected }));
    });
    health.listen(HEALTH_PORT);

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, async () => {
            logger.info({ signal }, `${service} berhenti`);
            shuttingDown = true;
            health.close();
            await connection?.close().catch(() => undefined);
            process.exit(0);
        });
    }

    void connect();
}
