import amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const QUEUE_NAME = 'q_dashboard_updater';

async function startDashboardConsumer() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();

        const exchangeName = 'hazard_events';
        await channel.assertExchange(exchangeName, 'fanout', { durable: true });

        const q = await channel.assertQueue(QUEUE_NAME, { durable: true });
        await channel.bindQueue(q.queue, exchangeName, '');

        console.log(`[Dashboard] Menunggu event di antrean ${q.queue}...`);

        channel.consume(q.queue, (msg) => {
            if (msg !== null) {
                const event = JSON.parse(msg.content.toString());
                console.log(`[Dashboard] Menerima update untuk diproses ke UI: ${event.hazard_id} - ${event.severity}`);
                
                // Konfirmasi pesan berhasil diproses
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error('[Dashboard] Gagal terhubung ke RabbitMQ:', error);
    }
}

startDashboardConsumer();