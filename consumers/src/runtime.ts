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

    // P5: deduplicate by hazard_id so re-published late-warning updates are not double-processed.
    // Bounded LRU-style Set: keep last 10 000 IDs in memory; clear when it grows too large.
    const seenIds = new Set<string>();
    const MAX_SEEN = 10_000;

    async function connect(): Promise<void> {
        try {
            const conn = await amqp.connect(RABBITMQ_URL);
            const channel = await conn.createChannel();

            await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });
            // durable: true so the queue survives a broker restart (P5 delivery semantics)
            const q = await channel.assertQueue(queue, { durable: true });
            await channel.bindQueue(q.queue, EXCHANGE, '');

            conn.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'RabbitMQ connection error'));
            conn.on('close', () => {
                connection = undefined;
                if (shuttingDown) return;
                logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'RabbitMQ connection lost');
                setTimeout(connect, RECONNECT_DELAY_MS);
            });
            connection = conn;

            logger.info({ queue: q.queue }, 'Waiting for events');

            await channel.consume(q.queue, (msg) => {
                if (msg === null) return;

                const log = logger.child({ correlation_id: msg.properties.correlationId });

                // P5: protect JSON.parse — a malformed message must not crash the process
                let event: any;
                try {
                    event = JSON.parse(msg.content.toString());
                } catch (err) {
                    log.error({ error: errorMessage(err) }, 'Invalid message (not JSON) — nacking without requeue');
                    // nack without requeue so the message goes to the dead-letter queue
                    channel.nack(msg, false, false);
                    return;
                }

                // P5: deduplicate — skip messages we have already processed
                const hazardId: string | undefined = event?.hazard_id;
                if (hazardId) {
                    if (seenIds.has(hazardId)) {
                        log.debug({ hazard_id: hazardId }, 'Duplicate hazard_id — skipping');
                        channel.ack(msg);
                        return;
                    }
                    seenIds.add(hazardId);
                    // Prevent unbounded growth
                    if (seenIds.size > MAX_SEEN) {
                        const [oldest] = seenIds;
                        seenIds.delete(oldest);
                    }
                }

                try {
                    handle(event, log);
                } catch (err) {
                    log.error({ hazard_id: hazardId, error: errorMessage(err) }, 'Handler error — nacking without requeue');
                    channel.nack(msg, false, false);
                    return;
                }

                channel.ack(msg);
            });
        } catch (error) {
            logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Failed to connect to RabbitMQ');
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
            logger.info({ signal }, `${service} shutting down`);
            shuttingDown = true;
            health.close();
            await connection?.close().catch(() => undefined);
            process.exit(0);
        });
    }

    void connect();
}
