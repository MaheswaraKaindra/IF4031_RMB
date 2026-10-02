import { runConsumer } from './runtime.js';

runConsumer({
    service: 'consumer-notifier',
    queue: 'q_field_notifier',
    handle: (event, log) => {
        // Kirim notifikasi (SIAGA, AWAS)
        if (event.severity === 'SIAGA' || event.severity === 'AWAS') {
            log.warn({ hazard_id: event.hazard_id, area_name: event.area_name, severity: event.severity }, 'MENGIRIM PERINGATAN DARURAT');
        } else {
            log.info({ hazard_id: event.hazard_id, severity: event.severity }, 'Event diabaikan');
        }
    },
});
