import { runConsumer } from './runtime.js';

const AGGREGATOR_URL = (process.env.AGGREGATOR_URL || 'http://aggregator:3000').replace(/\/$/, '');
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS || 1500);
const ACK_ATTEMPTS = Number(process.env.ACK_ATTEMPTS || 3);

// Records that Tim Lapangan received the alert. 404 means the event has no ledger entry (not a coastal delivery).
async function recordReceipt(event: any, traceparent?: string): Promise<void> {
    if (typeof event?.hazard_id !== 'string') return;
    // Up to ACK_ATTEMPTS tries, each on a fresh connection (`connection: close`), so after a node loss a try that landed on the dead pod's address
    // is followed by one that can land on a live pod, instead of the message going back to the queue after every failed try.
    let last: unknown;
    for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`${AGGREGATOR_URL}/internal/deliveries/ack`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', connection: 'close', ...(traceparent ? { traceparent } : {}) },
                body: JSON.stringify({ hazard_id: event.hazard_id, receiver: 'field-team' }),
                signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
            });
            if (res.status === 404) return;
            if (res.ok) return;
            last = new Error(`ack failed with HTTP ${res.status}`);
        } catch (err) {
            last = err;
        }
    }
    throw last instanceof Error ? last : new Error('ack failed');
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
