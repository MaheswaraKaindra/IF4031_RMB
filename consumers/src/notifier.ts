import { runConsumer } from './runtime.js';

runConsumer({
    service: 'consumer-notifier',
    queue: 'q_field_notifier',
    handle: (event, log) => {
        // Send notification (SIAGA, AWAS)
        if (event.severity === 'SIAGA' || event.severity === 'AWAS') {
            log.warn({ hazard_id: event.hazard_id, area_name: event.area_name, severity: event.severity }, 'SENDING EMERGENCY ALERT');
        } else {
            log.info({ hazard_id: event.hazard_id, severity: event.severity }, 'Event ignored');
        }
    },
});
