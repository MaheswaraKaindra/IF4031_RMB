import { runConsumer } from './runtime.js';

const AGGREGATOR_URL = (process.env.AGGREGATOR_URL || 'http://aggregator:3000').replace(/\/$/, '');
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS || 1000);

// Records that Tim Lapangan received the alert. 404 means the event has no ledger entry (not a coastal delivery).
async function recordReceipt(event: any, traceparent?: string): Promise<void> {
    if (typeof event?.hazard_id !== 'string') return;
    const res = await fetch(`${AGGREGATOR_URL}/internal/deliveries/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(traceparent ? { traceparent } : {}) },
        body: JSON.stringify({ hazard_id: event.hazard_id, receiver: 'field-team' }),
        signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
    });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`ack failed with HTTP ${res.status}`);
}

runConsumer({
    service: 'consumer-notifier',
    queue: 'q_field_notifier',
    criticalQueue: 'q_critical_alerts_v2',
    criticalRoutingKeys: ['critical.field_report', 'critical.coastal'],
    onCriticalReceived: (event, _log, traceparent) => recordReceipt(event, traceparent),
    handle: (event, log) => {
        if (event.severity === 'SIAGA' || event.severity === 'AWAS') {
            log.warn({ hazard_id: event.hazard_id, area_name: event.area_name, severity: event.severity }, 'SENDING EMERGENCY ALERT');
        } else {
            log.info({ hazard_id: event.hazard_id, severity: event.severity }, 'Event ignored');
        }
    },
});
