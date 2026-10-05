import { runConsumer } from './runtime.js';

// Third consumer used in the P5 demo: it only needs its own queue bound to the existing fanout exchange,
// the Aggregator (producer) is not changed or restarted.
runConsumer({
    service: 'consumer-portal',
    queue: 'q_regional_portal',
    handle: (event, log) => {
        log.info({ hazard_id: event.hazard_id, area_name: event.area_name, severity: event.severity }, 'Regional portal feed updated');
    },
});
