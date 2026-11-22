# Coastal service objectives

P5.1 requires zero lost critical alerts for Tim Lapangan and end-to-end p95 of at most 5 seconds. The coastal dashboard also defines two operating targets for the selected observation window.

| Indicator | Success and denominator | Target |
|---|---|---|
| Critical alert timeliness | A unique expected alert–receiver delivery is acknowledged within 5 seconds of source emission, divided by all expected deliveries emitted in the window. Keep late and unacknowledged deliveries in the denominator. | 99% timely |
| Tim Lapangan admission | Admitted field-team requests divided by all field-team admission decisions during the window. Exhaustion of reserved capacity counts against the target. | 99.5% admitted |

For controlled tests, use the entire emission or request window and state how long delivery was observed after emission ended. Reconcile unique expected alert IDs from the source with first receiver acknowledgements recorded in the ledger. Report pending deliveries at the observation cutoff, delivery count, deadline misses and p95 of observed acknowledgement latencies. An outstanding delivery is a deadline miss once its 5 seconds elapse. A p95 over acknowledgements alone is insufficient for acceptance if deliveries are still missing. In the fake-sensor test, latency uses emission time and clock-offset correction. The real-sensor emission boundary remains to be agreed.

In Grafana, the timeliness histogram starts at ledger registration and includes acknowledged deliveries. Pair that panel with the pending ledger count and source reconciliation to measure the full path. The Tim Lapangan panel plots a one-minute admission ratio. For a full test window, sum admitted and total decisions over that window before dividing. Inspect HTTP results and field-report acceptance separately to capture failures after admission. A window with zero expected events or decisions has no SLI sample.

The allowed bad-event fraction is 1% for timeliness and 0.5% for admission. Budget consumed is `100 × bad events / (eligible events × allowed bad-event fraction)`. The real node-loss run used **6,533% of the test-window timeliness budget** (196 late of 300, with a budget of 3). All 300 were eventually acknowledged and p95 was 34 seconds. The measured results are in [Phase 2 evidence](evidence/pc-run-phase2.md).
