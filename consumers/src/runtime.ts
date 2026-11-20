import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import amqp from 'amqplib';
import pino, { type Logger } from 'pino';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8095', 10);
const EXCHANGE = 'hazard_events';
const CRITICAL_EXCHANGE = 'hazard_critical';
const RECONNECT_DELAY_MS = 5000;
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/$/, '');
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

export interface ConsumerOptions {
    service: string;
    queue: string;
    criticalQueue?: string | undefined;
    criticalRoutingKeys?: string[] | undefined;
    handle: (event: any, log: Logger) => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

class DurableDedupStore {
    private readonly seen = new Set<string>();
    private readonly maxInMem = 50_000;

    constructor(private readonly filePath: string) {
        try {
            if (existsSync(filePath)) {
                const lines = readFileSync(filePath, 'utf8').split('\n');
                for (const line of lines) {
                    const k = line.trim();
                    if (k) this.rememberInMem(k);
                }
            }
        } catch {
            // Start with empty dedup if file is unreadable
        }
    }

    has(key: string): boolean {
        return this.seen.has(key);
    }

    record(key: string): void {
        if (this.seen.has(key)) return;
        this.rememberInMem(key);
        try {
            appendFileSync(this.filePath, `${key}\n`, 'utf8');
        } catch {
            // In-memory set remains active
        }
    }

    private rememberInMem(key: string): void {
        this.seen.add(key);
        if (this.seen.size > this.maxInMem) {
            const oldest = this.seen.values().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
    }
}

export function runConsumer({ service, queue, criticalQueue, criticalRoutingKeys, handle }: ConsumerOptions): void {
    const logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        base: {
            service,
            ...(process.env.POD_NAME || process.env.HOSTNAME ? { pod: process.env.POD_NAME || process.env.HOSTNAME } : {}),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level: (label) => ({ level: label }),
        },
    });

    const dedup = new DurableDedupStore(process.env.DEDUP_STORE_PATH || `/tmp/dedup-${service}.log`);
    const msgMetrics = new Map<string, number>();
    const incMsg = (q: string, outcome: string) => {
        const k = `${q}|${outcome}`;
        msgMetrics.set(k, (msgMetrics.get(k) ?? 0) + 1);
    };

    let connection: amqp.ChannelModel | undefined;
    let shuttingDown = false;

    function emitConsumerSpan(msg: amqp.ConsumeMessage, queueName: string, wallStart: number, ok: boolean): void {
        if (!OTLP_ENDPOINT) return;
        const tp = msg.properties.headers?.['traceparent'];
        const m = typeof tp === 'string' ? TRACEPARENT_RE.exec(tp) : null;
        if (!m) return;
        const traceId = m[1]!.toLowerCase();
        const parentSpanId = m[2]!.toLowerCase();
        const spanId = randomBytes(8).toString('hex');
        const wallEnd = Date.now();
        void fetch(`${OTLP_ENDPOINT}/v1/traces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                resourceSpans: [{
                    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
                    scopeSpans: [{
                        scope: { name: 'bnpb-otel' },
                        spans: [{
                            traceId,
                            spanId,
                            parentSpanId,
                            name: `consume ${queueName}`,
                            kind: 5,
                            startTimeUnixNano: `${wallStart}000000`,
                            endTimeUnixNano: `${Math.max(wallEnd, wallStart + 1)}000000`,
                            status: { code: ok ? 1 : 2 },
                            attributes: [
                                { key: 'messaging.destination', value: { stringValue: queueName } },
                                { key: 'x-correlation-id', value: { stringValue: String(msg.properties.correlationId ?? '') } },
                            ],
                        }],
                    }],
                }],
            }),
            signal: AbortSignal.timeout(1500),
        }).catch(() => undefined);
    }

    function wireConsumer(channel: amqp.Channel, queueName: string): Promise<amqp.Replies.Consume> {
        return channel.consume(queueName, (msg) => {
            if (msg === null) return;
            const wallStart = Date.now();
            const log = logger.child({ correlation_id: msg.properties.correlationId, queue: queueName });

            let event: any;
            try {
                event = JSON.parse(msg.content.toString());
            } catch (err) {
                log.error({ error: errorMessage(err) }, 'Invalid message (not JSON), rejecting without requeue');
                incMsg(queueName, 'invalid_json');
                channel.nack(msg, false, false);
                emitConsumerSpan(msg, queueName, wallStart, false);
                return;
            }

            const hazardId: string | undefined = event?.hazard_id;
            const dedupKey = hazardId ? `${hazardId}:${event?.severity}` : undefined;
            if (dedupKey && dedup.has(dedupKey)) {
                log.debug({ hazard_id: hazardId, severity: event?.severity }, 'Duplicate message, skipping');
                incMsg(queueName, 'duplicate');
                channel.ack(msg);
                emitConsumerSpan(msg, queueName, wallStart, true);
                return;
            }

            try {
                handle(event, log);
            } catch (err) {
                log.error({ hazard_id: hazardId, error: errorMessage(err) }, 'Handler error, rejecting without requeue');
                incMsg(queueName, 'error');
                channel.nack(msg, false, false);
                emitConsumerSpan(msg, queueName, wallStart, false);
                return;
            }

            if (dedupKey) dedup.record(dedupKey);
            incMsg(queueName, 'processed');
            channel.ack(msg);
            emitConsumerSpan(msg, queueName, wallStart, true);
        });
    }

    async function connect(): Promise<void> {
        try {
            const conn = await amqp.connect(RABBITMQ_URL);
            const channel = await conn.createChannel();

            await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });
            const q = await channel.assertQueue(queue, { durable: true });
            await channel.bindQueue(q.queue, EXCHANGE, '');
            await channel.prefetch(10);

            conn.on('error', (error) => logger.warn({ error: errorMessage(error) }, 'RabbitMQ connection error'));
            conn.on('close', () => {
                connection = undefined;
                if (shuttingDown) return;
                logger.warn({ retry_in_ms: RECONNECT_DELAY_MS }, 'RabbitMQ connection lost');
                setTimeout(connect, RECONNECT_DELAY_MS).unref();
            });
            connection = conn;

            logger.info({ queue: q.queue }, 'Waiting for events');
            await wireConsumer(channel, q.queue);

            if (criticalQueue) {
                const critChannel = await conn.createChannel();
                await critChannel.assertExchange(CRITICAL_EXCHANGE, 'direct', { durable: true });
                const cq = await critChannel.assertQueue(criticalQueue, { durable: true });
                for (const rk of criticalRoutingKeys ?? ['critical.field_report', 'critical.coastal']) {
                    await critChannel.bindQueue(cq.queue, CRITICAL_EXCHANGE, rk);
                }
                await critChannel.prefetch(20);
                logger.info({ queue: cq.queue }, 'Waiting for separate critical queue events');
                await wireConsumer(critChannel, cq.queue);
            }
        } catch (error) {
            logger.error({ error: errorMessage(error), retry_in_ms: RECONNECT_DELAY_MS }, 'Failed to connect to RabbitMQ');
            setTimeout(connect, RECONNECT_DELAY_MS).unref();
        }
    }

    const health = createServer((req, res) => {
        if (req.url === '/metrics') {
            const lines = [
                '# HELP consumer_messages_total Total messages handled by consumer',
                '# TYPE consumer_messages_total counter',
            ];
            for (const [k, v] of msgMetrics.entries()) {
                const [q, outcome] = k.split('|');
                lines.push(`consumer_messages_total{service="${service}",queue="${q}",outcome="${outcome}"} ${v}`);
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(lines.join('\n') + '\n');
            return;
        }
        if (req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        const connected = connection !== undefined && !shuttingDown;
        res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: connected ? 'ok' : 'degraded', service, broker_connected: connection !== undefined }));
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
