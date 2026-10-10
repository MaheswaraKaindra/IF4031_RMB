import { runConsumer } from './runtime.js';

runConsumer({
    service: 'consumer-dashboard',
    queue: 'q_dashboard_updater',
    handle: (event, log) => {
        log.info({ hazard_id: event.hazard_id, severity: event.severity }, 'Received update for UI processing');
    },
});
