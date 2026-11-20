# Phase 2 evidence: Owner A + B + C integrated on the 3-VM cluster

Date: 2026-11-20/21. Branch `integration/phase2` = Owner A's platform and storage + Owner B's coordination and messaging (P2, P3) + Owner C's
satellite and coastal pipelines (P4, P5), merged without touching the owners' own branches. Environment as in `pc-run-phase1.md`
(3 VirtualBox VMs, k3s, MongoDB 4.4); nodes are node-a, node-c, node-d.

## Final state and reproducibility

| Check | Result |
|---|---|
| Unit tests | aggregator 106/106, client-api 6/6 (run one file at a time with a per-test timeout) |
| One-command deploy from an EMPTY namespace | `scripts/deploy.sh demo` rebuilt the whole system, with no manual step, in 452 s counted from deleting the namespace (including all PVCs and data); 40 pods Ready |
| `verify-resources`, `verify-isolation`, `smoke`, `p2-placement`, `p2-single-fetch` on the rebuilt system | all pass |
| Broker | RabbitMQ is a 3-node cluster (Owner C) with quorum queues; Prometheus scrapes it |
| P1 on the rebuilt system | 50,000 events: max node share 0.668; hotspot ratio < 2; 70k+ record listing complete, unique and ordered |

## Per criterion (real VMs unless stated)

### P2 (Owner B)
| # | Criterion | Result | Measured |
|---|---|---|---|
| 1 | >= 3 instances on different nodes, routing only to healthy ones | PASS | `p2-placement.sh`: replicas on 3 nodes (hard spread with `matchLabelKeys`), readiness probe, Service endpoints = Ready pods |
| 2 | each source fetched exactly once | PASS | `p2-single-fetch.sh`: 0 duplicates in the store, one caller per mock = the Lease holder, poll rate not multiplied |
| 3 | failover <= 60 s, no gap, no duplicate | PASS | `p2-failover.sh` (node of the leader powered off): takeover **20.2 s**, exactly one leadership change, longest upstream pause 6.8 s, 0 duplicates, 0 records lost. Before two fixes (below) it took 38 s, flapped and stalled polling for about 2 minutes |
| 4 | clock shift +45 s then -30 s | PASS | `p2-clock-skew.sh`: 0 leadership changes, never two valid leaders in 54 samples, 0 duplicates. Before the lease fix the same test gave 10 leadership changes in 3 minutes |
| 5 | frozen node wakes up | PASS | `p2-freeze.sh` (VM paused 28 s, then resumed): the old leader stopped acting as leader within ~1 s, made 0 upstream polls, 0 duplicates, 0 records lost |
| 6 | sustained load while scaling 3-5-2-3 | PASS at a sustainable rate | `p2-load.sh` at a fixed 60 req/s for 150 s: 10,290 requests, 0.76% errors (< 1%), criterion 2 still holds. **Not** at 10,000 VU, see below |
| 7 | throughput with 3 instances >= 2.0x one instance | NOT DEMONSTRATED | at saturation the successful rate was 22 vs 52 req/s (2.34x) in one run and 564 vs 403 req/s (0.72x) in another, with 12-51% failures: the platform is saturated by network overhead, not by the aggregator, so the ratio is not a valid measurement |
| 8 | rolling update during load without a failed request | PASS | 3 consecutive rolling updates at 60 req/s: 0 failed requests (before the client-api retry: 1 failure in about 4,100 requests) |

**Capacity limit.** During the load all three VMs reached 94-98% CPU with about half of it kernel time (`vmstat`: us 45%, sy 50%, PSI 60-75%).
The multi-hop path NodePort -> client-api -> aggregator -> mongos -> shards through flannel VXLAN and kube-proxy on virtual NICs sustains roughly 100-150
req/s (p50 23 ms, p95 65 ms at 100 req/s, 0 failures); at 200 req/s it collapses into 2 s timeouts (p50 3 s, 80% failures). 10,000 VU cannot be
generated from this PC (k6 needs more memory than the host can spare next to 21 GB of VMs), so the results are reported at the sustainable rate.

### P3 (Owner B)
`p3-checks.sh`: 24 of 24 checks pass, also on the rebuilt system. Additive schema change accepted; rename, type change and missing field parked with
reason, source, time and `retryable:false`; 4 malformed payload kinds (truncated, deeply nested, invalid UTF-8, oversized) parked whole, 0 restarts, BMKG kept flowing;
replay recovered what a rule change can recover (the rest stays parked), 0 duplicates; Ops-only access (403, 403, 200); 20/20 field reports answered 202 in under 1 s with the broker
down and all aggregator pods killed right after, 0 lost, 0 doubled. Not asserted on the cluster: per-key ordering after replay.

### P5 (Owner C), real sensor image and fake sensor
| Check | Result |
|---|---|
| Critical alerts, `coastal-tool synthetic` 200 at 50/s, deadline 5 s | 200/200 delivered within the deadline, p50 358 ms, p95 482 ms |
| `coastal-tool verify` against an independent crawl of the real sensor | 21,646 observations seen: 0 valid ones missing from the store, 0 critical lost, 0 contract violations, 3 critical delivered |
| `p5-checks.sh`, six fake-sensor modes (slow, blackhole, status 503, malformed, stale, frozen) | 6 of 6 pass: other sources kept ~30 ms (SEISMIC p95 < 33 ms), a sensor-dependent request answered in < 35 ms, requests to the sick sensor dropped to 8-13 per 40 s (baseline 39), the sensor was used again 1-3 s after recovery, no intervention |
| Not run | P5.6 and P5.8 (unannounced combined failures, game day) need the Tester Agent exam scenarios |

### P4 (Owner C)
Implemented and unit-tested (satellite tests pass) but **not run against the feed**: `SATELLITE_GROUP_TOKEN` is not available, so the pipeline stays off by design. `satellite-tool` needs the token.

### Tester Agent
Installed unmodified (digest verified). `schema` passes end to end after a fix (below); the other five practice scenarios (`kill-leader`, `kill-store`, `wipe-node`, `clock-skew`,
`partition`) report "no eligible target": all three of our nodes are k3s servers (control-plane) and the agent only targets worker nodes unless a group allows more. A node-label
workaround was rejected as tampering with the official agent, so these are **blocked on a topology or permission decision** (make two nodes k3s agents, or learn the allow mechanism from the assistants).

### Observability
Prometheus: 21/21 pod targets up (aggregator, client-api, auth, consumers, mocks, RabbitMQ, 3 MongoDB exporters) plus cAdvisor. Dashboards: BNPB overview (throughput, error rate, p95, 429, memory), BNPB coordination,
broker and store (leader and epoch, poll duration, inbox and outbox, RabbitMQ backlog and members, Mongo member state, replication lag, opcounters, coastal sensor requests), satellite, coastal.
Jaeger shows traces across client-api, aggregator and the three consumers. Gaps: mocks, store, broker and sensor emit no spans.

## Bugs found and fixed in this phase

| Bug | Fix |
|---|---|
| After a node loss, B's inbox, outbox, fencing and checkpoint writes failed with `w:2` write-concern timeouts (one shard member down), so a new leader could not commit and polling stalled for ~2 minutes | bookkeeping collections write with `w:1` only while the store is degraded and `w:2` otherwise (`storage/health.ts`) |
| Lease expiry compared an API-server `Date` header with `renewTime`; every k3s node runs an API server, so one drifted clock made instances disagree and leadership flapped (10 changes in 3 min) | expiry from "no change observed for the lease duration" on a monotonic clock (client-go's rule); a clean release hands over at once |
| Aggregator exited when index creation hit a write-concern timeout during recovery | retry with backoff (also for C's delivery ledger) |
| ~1 in 4,000 requests failed during a rolling update (keep-alive reset to a draining aggregator) | client-api retries an idempotent GET once on a connection-level error |
| C's coastal ledger used `$dateAdd` (MongoDB 5.0+), so the relay failed every 0.5 s on 4.4 and critical alerts were never marked delivered | `$add: ['$$NOW', ms]` |
| The official Tester Agent got HTTP 401 from the mocks' admin endpoints (it holds no secrets) | `ADMIN_OPEN=1` in the Kubernetes manifests makes `/admin/*` callable without the token (Compose keeps it) |
| Aggregator replicas could stack on one node after a rolling update (spread counted the old revision) | hard spread with `matchLabelKeys: [pod-template-hash]` |
| Single-replica CoreDNS, local-path provisioner and metrics-server | 3 and 2 replicas (`harden-platform.sh`, run by the deploy); dead-node detection ~48 s -> ~16 s (`tune-failure-detection.sh`) |
| `node --test` glob expansion needs Node >= 21 and the suite could hang | portable `find | xargs` runner, sequential, per-test timeout |
| P1/P3 scripts assumed a 1-pod broker and an exact redundancy match | broker replica count restored; `TOL` default 20; replace-script waits for the placement map |

## Open issues
- Tester Agent scenarios other than `schema` (decision above); exam scenarios need the key given at the demo.
- P4 against the real feed needs the satellite token; P5.6/P5.8 need the Tester Agent.
- 10,000 VU and the 2.0x throughput ratio cannot be shown on this hardware.
- Owner C's satellite suite had a flaky test (`crash after the checkpoint ... same final set`) and a hang once under the parallel runner; both disappeared with sequential execution, cause not isolated.
- Analytics dashboard in a browser (banner and compare button) was verified at API and HTML level only.
- Per-key ordering after replay, spans for mocks, store, broker and sensor.
