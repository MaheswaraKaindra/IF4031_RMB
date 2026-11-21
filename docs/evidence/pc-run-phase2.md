# Phase 2 evidence: Owner A + B + C integrated on the 3-VM cluster

Date: 2026-11-20/21. Branch `integration/phase2` = Owner A's platform and storage + Owner B's coordination and messaging (P2, P3) + Owner C's
satellite and coastal pipelines (P4, P5), merged without touching the owners' own branches. Environment as in `pc-run-phase1.md`
(3 VirtualBox VMs, k3s, MongoDB 4.4); nodes are node-a, node-c, node-d.

## Final state and reproducibility

| Check | Result |
|---|---|
| Unit tests | aggregator 138/138 in the latest suite, client-api 6/6 in the integration run (sequential, per-file timeout) |
| One-command deploy from an EMPTY namespace | `scripts/deploy.sh demo` rebuilt the whole system, with no manual step, in 452 s counted from deleting the namespace (including all PVCs and data); 40 pods Ready |
| `verify-resources`, `verify-isolation`, `smoke`, `p2-placement`, `p2-single-fetch` on the rebuilt system | all pass |
| Broker | RabbitMQ is a 3-node cluster (Owner C) with quorum queues; Prometheus scrapes it |
| P1 on the rebuilt system | 50,000 events: max node share 0.668; hotspot ratio < 2; 70k+ record listing complete, unique and ordered |

## Per criterion (real VMs unless stated)

### P1 simulated earthquake catalog (Owner A)

`store-tool catalog-gen --count 50000` generated earthquakes across 29 provinces, including aftershock bursts. The busiest one-degree cell held 2.2% of the input and the busiest province held 12.5%. `store-tool load --catalog` applied all 50,000 rows through the BMKG mapper in 120.19 s (416 writes/s).

`p1-hotspot.sh` then applied all 20,000 Sumatera Barat writes in 46.55 s (430 writes/s). Primary write counters increased by 7,103, 6,855 and 6,957. The max/min ratio was **1.036**, below the pass threshold of 2.

`p1-report.sh` reported 233,505 logical records under live ingestion and a maximum node share of **0.667**. The four source checksums were complete, all three shards were available and redundant, and the sample location returned both a primary and a replica.

After the measurements, a user-approved cleanup removed the 90,000 hazards with a `SYN-` source reference (63,263 BMKG, 13,469 PVMBG, 8,727 SATELIT, 4,541 SENSOR_PANTAI). MongoDB acknowledged the deletion at `w:2`. A follow-up count found zero `SYN-` records and all 50,000 catalog records.

### P2 (Owner B)
| # | Criterion | Result | Measured |
|---|---|---|---|
| 1 | >= 3 instances on different nodes, routing only to healthy ones | PASS | `p2-placement.sh`: replicas on 3 nodes (hard spread with `matchLabelKeys`), readiness probe, Service endpoints = Ready pods |
| 2 | each source fetched exactly once | PASS | `p2-single-fetch.sh`: 0 duplicates in the store, one caller per mock = the Lease holder, poll rate not multiplied |
| 3 | failover <= 60 s, no gap, no duplicate | PASS | `p2-failover.sh` (node of the leader powered off): takeover **20.2 s**, exactly one leadership change, longest upstream pause 6.8 s, 0 duplicates, 0 records lost. A later real power-off run measured takeover of all four leased sources in 24–26 s with 0 duplicates and 0 lost. Before two fixes (below) it took 38 s, flapped and stalled polling for about 2 minutes |
| 4 | clock shift +45 s then -30 s | PASS | `p2-clock-skew.sh`: 0 leadership changes, 0 overlapping leaders and 0 duplicates in 80+ sampled rounds in the later run. Polling now overlaps the previous cursor by 120 s and the test compares stored IDs with mock events produced during the run. Before the lease fix the same test gave 10 leadership changes in 3 minutes |
| 5 | frozen node wakes up | PASS | `p2-freeze.sh` (VM paused 28 s, then resumed): the old leader stopped acting as leader within ~1 s, made 0 upstream polls, 0 duplicates, 0 records lost |
| 6 | sustained load while scaling 3-5-2-3 | PASS at a sustainable rate | `p2-load.sh` at a fixed 60 req/s for 150 s: 10,290 requests, 0.76% errors (< 1%), criterion 2 still holds. **Not** at 10,000 VU, see below |
| 7 | throughput with 3 instances >= 2.0x one instance | NOT DEMONSTRATED | at saturation the successful rate was 22 vs 52 req/s (2.34x) in one run and 564 vs 403 req/s (0.72x) in another, with 12-51% failures: the platform is saturated by network overhead, not by the aggregator, so the ratio is not a valid measurement |
| 8 | rolling update during load without a failed request | PASS | 3 consecutive rolling updates at 60 req/s: 0 failed requests (before the client-api retry: 1 failure in about 4,100 requests) |

**Capacity limit.** During the load all three VMs reached 94-98% CPU with about half of it kernel time (`vmstat`: us 45%, sy 50%, PSI 60-75%).
The multi-hop path NodePort -> client-api -> aggregator -> mongos -> shards through flannel VXLAN and kube-proxy on virtual NICs sustains roughly 100-150
req/s (p50 23 ms, p95 65 ms at 100 req/s, 0 failures); at 200 req/s it collapses into 2 s timeouts (p50 3 s, 80% failures). 10,000 VU cannot be
generated from this PC (k6 needs more memory than the host can spare next to 21 GB of VMs), so the results are reported at the sustainable rate.

### P3 (Owner B)
`p3-checks.sh`: 33 of 33 checks passed in the latest run. Schema rules propagated to all replicas and survived a pod restart. Additive schema change accepted; rename, type change and missing field parked with
reason, source, time and `retryable:false`; 4 malformed payload kinds (truncated, deeply nested, invalid UTF-8, oversized) parked whole, 0 restarts, BMKG kept flowing;
replay recovered what a rule change can recover (the rest stays parked), 0 duplicates and no further recoveries on a second replay; Ops-only access (403, 403, 200); 20/20 field reports answered 202 in under 1 s with the broker
down and all aggregator pods killed right after, 0 lost, 0 doubled. Not asserted on the cluster: per-key ordering after replay.

### P5 (Owner C), real sensor image and fake sensor
| Check | Result |
|---|---|
| Critical alerts, `coastal-tool synthetic` 200 at 50/s, deadline 5 s | 200/200 delivered within the deadline, p50 358 ms, p95 482 ms |
| `coastal-tool verify` against an independent crawl of the real sensor | 21,646 observations seen: 0 valid ones missing from the store, 0 critical lost, 0 contract violations, 3 critical delivered |
| `p5-checks.sh`, six fake-sensor modes (slow, blackhole, status 503, malformed, stale, frozen) | 6 of 6 pass: other sources kept ~30 ms (SEISMIC p95 < 33 ms), a sensor-dependent request answered in < 35 ms, requests to the sick sensor dropped to 8-13 per 40 s (baseline 39), the sensor was used again 1-3 s after recovery, no intervention |
| Not run | P5.6 and P5.8 (unannounced combined failures, game day) need the Tester Agent exam scenarios |

#### Critical alert latency from sensor emission

`p5-latency.sh` uses a fake sensor at 5 alerts/s and measures from emission to acknowledgement.

| Scenario | Acknowledged | Latency and result |
|---|---:|---|
| Baseline | 300/300 | p95 1.59 s. Pass. |
| Leader-process crash | 400/400 | p95 2.57 s. Pass. |
| Real leader-node power-off | 300/300 | p50 9.4 s, p95 34 s, maximum 37 s. All acknowledged 20 s after emission ended. 196 of 300 missed 5 s. |

The node-loss run used `SCENARIO=node-loss N=300 RATE=5 FAIL_AT_S=25 COMPLETE_MAX_S=90 scripts/k8s/p5-latency.sh`. In earlier runs 302 of 500 alerts were missing from the ledger and subsequently 195 of 300 remained unacknowledged. The verified run included degraded write concerns for the ledger, feed log and late store, immediate degraded-mode canonical writes, non-blocking fast publish, and fresh-connection ACK retries with reactive degradation on a write-concern timeout (through `b868336`).

The measured coastal leader gap was 30–38 s, with approximately 16 s to detect node loss, stale Service endpoints and an 8 s coastal lease. The 104 alerts sent before power-off were on time. The latest run met the zero-loss criterion and exceeded the 5 s p95 deadline. The 196 misses consumed 6,533% of the 1% test-window timeliness budget. See [coastal service objectives](../slo.md).

#### P5 priority under Media load

On an idle cluster (normal background ingestion, no concurrent test, pre-test node CPU 21–31%), k6 ran for 40 s with 100 Media read VUs, 10 Tim Lapangan read VUs and 3 Tim Lapangan field-report VUs. Media received 1,395 HTTP 429s. Tim Lapangan reads received 0 HTTP 429s and 351 HTTP 200s. Read p95 was **1.88 s** against the test threshold of <1 s. The API accepted **105 of 107** field reports and refused 2, against a threshold of zero refusals. k6 exited 99 with `thresholds on metrics 'http_req_duration{client:field_team}, refused_field_report' have been crossed`. Three reads across both classes returned a status other than 200 or 429. The earlier busy-cluster run measured about 2.3 s read p95 and 3 of 82 field reports refused.

### P4 (Owner C)

| Check | Result |
|---|---|
| Real satellite feed | 1.17 million frames processed. Independent batch comparison found 18,378 matching fires, with 0 missing, 0 extra and 0 different. |
| Leader SIGKILL and real node power-off | New leader processing in 8 s and 57 s, respectively. Feed log contiguous through 1,189,412 frames and epoch advanced. |
| State rebuild | Processor snapshot reduced rebuild from 195 s to 0.3 s. |

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
- P5 timeliness under whole-node loss and field-team read latency and report acceptance under the tested Media load miss their thresholds. P5.6/P5.8 need the Tester Agent.
- 10,000 VU and the 2.0x throughput ratio cannot be shown on this hardware.
- Owner C's satellite suite had a flaky test (`crash after the checkpoint ... same final set`) and a hang once under the parallel runner; both disappeared with sequential execution, cause not isolated.
- Analytics dashboard in a browser (banner and compare button) was verified at API and HTML level only.
- Per-key ordering after replay, spans for mocks, store, broker and sensor.

## Targeted re-test on 2026-11-21

### P5 priority diagnosis

Both 40 s runs used 10 field-read VUs and 3 field-report VUs. The temporary instrumentation logged status and correlation ID on report failure without recording credentials or request bodies.

| Media VUs | Field-team read p95 | Reports accepted | Field-team read 429s | Media 429s | Result |
|---:|---:|---:|---:|---:|---|
| 60 | 1.272 s | 200/200 | 0 | 495 | k6 exit 99, read latency threshold exceeded |
| 100 | 1.465 s | 191/191 | 0 | 0 | k6 exit 99, read latency threshold exceeded |

The first run started with 47 active pods and the second with 54, so the results do not isolate the effect of Media VUs. The 100-VU run did not demonstrate controlled Media rejection. Retained client-api logs from the earlier idle run identify one of its two refused reports as HTTP 503 following a 2,018 ms failed call to the aggregator. The second refusal's status was not recovered. The evidence identifies a timeout on the aggregator call in one case and does not establish an admission-control defect.

### P1 simulated catalog and placement

A read-only recheck counted all 50,000 catalog records and zero synthetic-prefix records. `p1-report.sh` showed 144,477 logical records, a maximum node share of 0.667, and all three shards available and redundant. The original 20,000-write hotspot pass (ratio 1.036) remains the surge evidence. The recheck preserved the post-cleanup dataset.

### P1 empty-volume replacement and subsequent node loss

- **Slot 3, node-c, empty-volume replacement.** `p1-node-loss.sh 3` replaced all four store-member PVCs with new claims and restored both data copies on every shard. The test saw 59 complete and one explicitly partial Audit API or analytics response, plus 20 successful client API reads. There were zero bad or slow responses. It listed 144,513 records before and 144,619 after and found zero missing records in the ID containment check. The containment check excludes derived SATELIT fire records because the live feed can retract them. This phase wiped the slot's store volumes while the VM stayed on.
- **Slot 2, node-d, subsequent real power-off.** The manual run after slot 3 re-synced returned 51 complete and one explicitly partial Audit API or analytics response, plus 17 successful client API reads. Three probes failed: `/internal/audit/checksum`, `/internal/audit/events?limit=50`, and client `/events` (curl status `000`). The availability check failed. VirtualBox restarted node-d, but the guest did not answer ping or rejoin k3s during the 210 s probe window. The script saved a 144,634-record pre-loss baseline and exited before the post-loss comparison. A user-authorized second reset restored connectivity. The cluster then reported all nodes and pods Ready, all shard copies redundant, and no write-concern timeout logs in the previous three minutes. The follow-up listing found 144,889 records and zero missing checked IDs against the saved baseline. This verified recovery and containment for the local dataset, with the three failed probes still failing the availability check. The official catalog and checksum were unavailable. The probes checked read availability. Continuous write availability was not measured.

### P2 kind benchmark

The first four-node kind setup timed out waiting for `job/store-init`. Its initial replica-set initiation saw two config-member DNS names missing. The retry waited for all 12 MongoDB members before creating the bootstrap Job and passed initialization. The benchmark wrapper was interrupted before a usable k6 result was recovered. On inspection, the isolated cluster had multiple unready pods and kube-proxy logged `fsnotify watcher init: too many open files`. There is no new throughput ratio or 10,000-VU result. kind uses a shared kernel and is suitable for rehearsal evidence.

Further tuning of the P5 coastal node-loss latency was deferred by the user. The measured 34 s p95 and zero lost alerts remain recorded above.

### P5 priority with fixed replica counts

A focused 40 s retest pinned the aggregator at 3 replicas and client-api at 2, with 100 Media read VUs, 10 Tim Lapangan read VUs, and 3 field-report VUs. Both original HPA ranges were restored afterward. Media received 1,745 HTTP 429s. All 339 Tim Lapangan reads returned HTTP 200, with p95 1.831 s. Of 88 field-report POSTs, 87 returned HTTP 202 and one returned HTTP 503. k6 exited 99 after the read-latency and report-acceptance thresholds were crossed.

The failing report `k6-45-4-1795272290863` correlated with a client-api call to `POST /internal/field-reports` that failed with `timeout of 2000ms exceeded` (2,016 ms logged). A read-only lookup found the report in MongoDB's field-report outbox and canonical hazards, with the outbox marked published. The report for the earlier identifiable 503 (`k6-10-8-1795266383259`) was also present in both collections and marked published. The second earlier refusal still lacks a matching ID. The reproduced failure is a missing HTTP acknowledgement despite durable storage, with zero Tim Lapangan HTTP 429s observed in this run.

## Real power-off probe, 2026-11-21 (P1 criterion 4, gap diagnosis)

`scripts/k8s/p1-probe-loss.sh` probes the Audit API (`events`, `checksum`, `analytics/summary`) and the client API once per second through the NodePorts of node-a while node-d is powered off with `VBoxManage controlvm node-d poweroff`, and prints every probe with its time since the power-off.

- **Run 1 (before the change): invalid, test-environment freeze.** About 17 s after the power-off node-c froze with no log lines (hypervisor level; its journal ends at 15:08:21). Two of three etcd members were then gone, so the API server and every probe failed until `controlvm node-c reset`. This is not a system failure and is not used for any number.
- **Run 2 (before the change): 350 of 360 probes OK.** Failures in the window from +7 s to +39 s after the power-off. At +7 s and +19 s all three Audit probes timed out together and two client token requests failed. The aggregator logs show the cause: connections to the `mongos` ClusterIP (`10.43.232.192`) timed out from 15:28:09 to about 15:28:24, because the Service kept routing to the mongos pod on the dead node until its endpoint was removed.
- **Change:** the aggregator now connects through the headless Service `mongos-direct` with `mongodb+srv://...&srvServiceName=mongo&tls=false` (`k8s/store/mongos.yaml`, `scripts/k8s/create-secrets.sh`). The driver then sees both mongos pods, heartbeats them every second and stops selecting one that died. The init container keeps a plain URI (`MONGO_URI_PLAIN`) because the legacy `mongo` 4.4 shell has no SRV support. The store pods were not restarted by the change.
- **Run 3 (after, 8 s curl limit): 353 of 360 OK.** Remaining failures: analytics/checksum timeouts at +5.6 s, one `events` timeout at +14.6 s, two client token failures at +10.6 s and +19.6 s (auth-service reached through a NodePort endpoint that still pointed at the dead pod), and slow analytics at +36 s that is also seen with no failure injected.
- **Run 4 (after, 15 s curl limit): 358 of 360 OK.** All 90 client API probes and every `events` probe succeeded. The only two failures were `analytics` (15 s, at −2.3 s, before the power-off) and `checksum` (15 s, at +13.7 s).
- **Limits found, not fixed.** (1) `analytics/summary` and `audit/checksum` are full scans: 2.4 to 6.6 s on these VMs for about 146,000 records (the `store scan` log lines), bounded by design at 8 s, and with three of them running at once a few exceeded the 15 s probe limit even with no failure. (2) Requests entering through a NodePort can still reach a pod on a dead node until Kubernetes marks the node NotReady (about 16 s with the tuned grace period); run 3 showed this for auth-service. The sample is small (two runs after the change), so this shows the failures shrank, not that they are gone.
- **Environment.** node-c (run 1) and node-a (during the rollout) froze with no log lines and were reset with `controlvm reset`; each was counted as a test-environment problem.

## Trace through every hop, 2026-11-21 (Observability criterion 2)

New child spans: `store ingest` / `store accept field report` (the store write) and `broker publish` / `broker publish field report` (the broker hop), with the publish span's `traceparent` passed to the consumers. One `POST /field-reports` with correlation ID `trace-1795279060` through the NodePort of node-a produced this trace in Jaeger (trace `6282bdd95acfb0ffd0a042284ee3ab65`, start offset and duration in ms):

| Start | Duration | Service | Span | Parent |
|---|---|---|---|---|
| 0 | 175 | client-api | `POST /field-reports/` | none |
| 50 | 105 | aggregator | `POST /internal/field-reports` | client-api request |
| 96 | 52 | aggregator | `store accept field report` | aggregator request |
| 308 | 35 | aggregator | `broker publish field report` | aggregator request |
| 326 / 336 / 337 | 1 | consumer-notifier, consumer-dashboard, consumer-portal | `consume q_field_notifier` / `q_dashboard_updater` / `q_regional_portal` | broker publish |
| 354 | 85 | consumer-notifier | `consume q_critical_alerts_v2` | broker publish |
| 373 | 60 | aggregator | `POST /internal/deliveries/ack` | broker publish |

The poll-driven critical alert path was not re-traced in this run. Its `store ingest` span is a child of the `poll`/`coastal critical ingest` span in the same way (covered by the unit tests only; a Jaeger capture of a coastal alert is not verified).

## P3 per-key replay order on the cluster, 2026-11-22 (P3 criterion 4)

`scripts/k8s/p3-order.sh` (5 checks, all PASS). The versions are stored in the parked inbox by `dist/tools/inbox-tool.js` the way the aggregator parks an unreadable message, because the PVMBG mock cannot serve several versions of one report. The last version is stored first, but with the latest received time, so only an ordered replay gives the right result.

- **Key A** (Waspada, then Awas, both readable after the rule change): both recovered; `processed_at` of version 1 (17:04:29.797) is before version 2 (17:04:29.867); exactly one stored event, with the newer level AWAS.
- **Key B** (the first version stays unreadable after the rule change: `alert_level` not a level): neither version processed, no event stored; the replay answered `scanned 16, recovered 2, blocked_by_key 1, still_failed 13` (the other 12 failed messages are the earlier real parked PVMBG messages).
- The script removes its own `ORD-` test messages and events and turns the schema rule off again. Two earlier aborted runs of the script (the tool did not exit) had left one `ORD-` key behind; it was removed with `inbox-tool purge`, and a final count shows no `ORD-` message or event left.
- A new field `processed_at` is stored on every inbox message when it is marked processed (`MongoRawInbox.markProcessed`).

## P5 refused field report: cause and change, 2026-11-22 (P5 criterion 5)

Cause (from the earlier diagnosis above): under the Media flood the aggregator sometimes answered `POST /internal/field-reports` later than client-api's 2 s limit although the report was already stored and published, so the client received HTTP 503 for a report the system had accepted. Not an admission-control defect (no Tim Lapangan request got a 429).

Change: client-api now repeats that POST once (3 s limit, `FIELD_REPORT_RETRY_TIMEOUT_MS`) after a timeout or a broken connection. This is safe because the aggregator stores a report under its idempotency key, so a repeat is answered 202 `duplicate` (`client-api/src/retry.ts`, 3 unit tests). **Not verified under load:** the priority test was not re-run after the change (the user will run it together with the report screenshots), so it is not shown that the 503s are gone.
