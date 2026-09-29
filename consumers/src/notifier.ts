import amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const QUEUE_NAME = 'q_field_notifier';

async function startNotifierConsumer() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();

        const exchangeName = 'hazard_events';
        await channel.assertExchange(exchangeName, 'fanout', { durable: true });

        const q = await channel.assertQueue(QUEUE_NAME, { durable: true });
        
        await channel.bindQueue(q.queue, exchangeName, '');

        console.log(`[Notifier] Menunggu event di antrean ${q.queue}...`);

        channel.consume(q.queue, (msg) => {
            if (msg !== null) {
                const event = JSON.parse(msg.content.toString());
                
                // Kirim notifikasi (SIAGA, AWAS)
                if (event.severity === 'SIAGA' || event.severity === 'AWAS') {
                    console.log(`[Notifier] MENGIRIM PERINGATAN DARURAT: ${event.hazard_id} di wilayah ${event.area_name}!`);
                } else {
                    console.log(`[Notifier] Event ${event.hazard_id} diabaikan (Status: ${event.severity})`);
                }
                
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error('[Notifier] Gagal terhubung ke RabbitMQ:', error);
    }
}

startNotifierConsumer();