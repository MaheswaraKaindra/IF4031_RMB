# Spec tracker: IF4031 Milestone 2

One row per requirement of the official spec (`IF4031 - Tugas Besar - M2.pdf`). Status is taken only from what was measured; details and numbers are in `docs/evidence/pc-run-phase2.md`.

**Status:** PASS = measured on the real 3-VM cluster and met. PASS* = met, with a limit that must be written in the report. PARTIAL = part measured or part met. NOT TESTED = no measurement yet. WAITING = needs the assistants' material (released after the deadline). FAIL = measured and not met.
**Proof:** what the report must contain for this criterion (spec: "Bukti penyelesaian per kriteria": screenshot, log excerpt with correlation ID, measurement or load-test output). "Re-run" = the user will repeat it while taking screenshots.

Last updated 2026-11-22, after the sweep (commit `fd03772` and later).

## Problem 1: storage (A2)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 1.1 | Load the assistants' historical catalog; no node holds all data; load spread over more than one node; report distribution per node | Simulated 50,000-record catalog | PASS* (simulated); real catalog WAITING | `store-tool catalog-gen/load`, `p1-report.sh`, `p1-load.sh` | Table of records per node and write counters; screenshot of `p1-report.sh` |
| 1.2 | Show how the system handles the dataset's natural skew; measure per-node load while loading and during a regional burst | Yes (simulated hot zones, Sumatra burst) | PASS* (simulated) | `p1-hotspot.sh`, `store-tool burst` | Per-node load before/after the burst; screenshot |
| 1.3 | Cross-location query ("50 newest of all hazards") with pagination and correct order | Yes | PASS | `p1-query.sh` | Request/response excerpt, order check output |
| 1.4 | Node worker killed and its data erased: no HazardEvent lost (checked through Audit API against the assistants' checksum); every request answered complete or explicitly partial, never 500 or hang | Real power-off and empty-volume replacement; nothing lost against our own baseline | PASS* | `p1-node-loss.sh`, `p1-probe-loss.sh`, `p1-unit-loss.sh`. Real power-off probes after the SRV change: 358/360 and 353/360 OK. Limits: a request through a NodePort can still reach a dead pod for about 16 s; `analytics`/`checksum` full scans take 2.4-6.6 s | Probe timeline, partial-answer example, lost = 0 output; official checksum WAITING |
| 1.5 | New or emptied node takes over data and load without stopping writes or reads | Yes: empty-volume replacement of slot 3 with writes and reads running (488/488 writes accepted and stored, 57 complete reads, 0 bad); writes also through a real power-off (264/264) | PASS | `p1-node-loss.sh 3`, `p1-write-probe.sh` | Re-sync log, redundancy output, write probe output |
| 1.6 | After 1.4 and 1.5 the system survives the next node loss | Yes (slot 2 power-off after slot 3 re-synced; nothing lost) | PASS* (the three failed probes of that run were before the SRV change) | evidence section "P1 empty-volume replacement and subsequent node loss" | Output of the second loss |
| 1.7 | Browser analytics dashboard: line chart per hazard type with time range, count per severity, count per area; numbers equal the Audit API; marked incomplete when a node is down | Page and partial flag exist; NOT checked in a browser | NOT TESTED in a browser (user) | `aggregator/src/storage/analyticsPage.ts` | Screenshots: normal, and with a node down showing the incomplete banner; numbers next to the Audit API output |
| 1.R | Report items: problem name and concept, mechanism and placement rule, two alternatives, per-endpoint consistency, how dashboard numbers are computed and flagged | n/a | Text, user-supervised | `docs/report-draft.md`, `docs/decisions/ADR-0001-storage.md` | Written text |

## Problem 2: coordination (B)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 2.1 | At least 3 instances on different nodes behind one entry point that stops routing to unhealthy ones | Yes | PASS | `p2-placement.sh` | `kubectl get pods -o wide`, Service endpoints |
| 2.2 | Every source fetched exactly once; no duplicate HazardEvent; upstream sees no multiplied requests (upstream log) | Yes (4 sources) | PASS | `p2-single-fetch.sh` | Upstream log counts per pod, duplicate check |
| 2.3 | Fetcher dies: another instance continues within 60 s, no gap, no duplicate | Yes | PASS (24-26 s) | `p2-failover.sh` | Timeline of the lease takeover |
| 2.4 | Clock shifted (+45 s, then -30 s): never two instances saving in the same period | Yes | PASS | `p2-clock-skew.sh` | Sampler output "never two leaders" |
| 2.5 | Leader frozen longer than the limit, wakes up: stores nothing until its status is refreshed | Yes | PASS | `p2-freeze.sh` | Output with fencing rejections |
| 2.6 | Sustained load of at least 10,000 VU for at least 120 s while instances go 3 -> 5 -> 2; error rate outside controlled rejection below 1%, criterion 2 still holds | No. The VMs saturate at about 110 req/s through the NodePort; kind attempt failed (kube-proxy "too many open files") and kind is not allowed for the demo | NOT TESTED (kind run is last) | `scripts/k8s/p2-load.sh`, `load-test/` | k6 output, configuration and tooling (report item 4) |
| 2.7 | Throughput with 3 instances at least 2.0x one instance | No | NOT TESTED | as above | Throughput numbers |
| 2.8 | Version swap during the load test without a failed request | No (a rolling update was only observed informally) | NOT TESTED | as above | k6 failures = 0 during the rollout |
| 2.R | Report items: problem names, time source and why safe for 2.4 and 2.5, lease/timeout values and trade-off, load-test configuration | n/a | Text | `docs/p2-p3-design.md` | Written text |

## Problem 3: schema change and field reports (B)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 3.1 | Declare what is accepted automatically and what is not; behaviour matches on the PVMBG mock | Yes | PASS | `p3-checks.sh` (33 checks) | Declaration table plus output |
| 3.2 | Unprocessable messages kept whole with reason, source, time; retryable and non-retryable treated differently | Yes | PASS | `p3-checks.sh` | Parked message listing, reasons |
| 3.3 | Corrupt messages (truncated JSON, deep nesting, bad UTF-8, oversized) crash nothing; other data keeps flowing | Yes | PASS | `p3-checks.sh` | Restart counts, flow check |
| 3.4 | After adapting to the schema change, replay: everything recovered, no duplicate, per-`source_ref_id` order kept | Yes (replay, no duplicates; order on the cluster added) | PASS | `p3-checks.sh`, `p3-order.sh` (5 checks) | Replay output; order evidence (processed_at v1 < v2, unreadable first version blocks the key) |
| 3.5 | Only BNPB Internal Ops can inspect failed messages | Yes | PASS | `p3-checks.sh` | 403 for Media/Field, 200 for Ops |
| 3.6 | `POST /field-reports` answers 202 quickly even when downstream is slow or dead; receiver may die after the 202; no 202'd report lost or processed twice | Yes (broker down, all aggregators killed; 20/20; also 264/264 through a node power-off) | PASS | `p3-checks.sh`, `p1-write-probe.sh` | Counts accepted / stored / duplicated |
| 3.R | Report items: names, schema policy and reasons, store/inspect/replay and duplicate prevention, delivery guarantee on the field-report path with proof | n/a | Text | `docs/p2-p3-design.md` | Written text |

## Problem 4: satellite feed (C)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 4.1 | Hotspots become WILDFIRE HazardEvents per the definition; one fire seen by several satellites = one event | Yes (real feed, 1.17M frames) | PASS | `satellite-tool reference`: 18,378 fires, 0 missing, 0 extra, 0 different against an independent batch computation | Comparison output |
| 4.2 | Grouped by detection time, not arrival time; stated lateness limit; late detections within the limit still update the fire; later ones not dropped silently and counted | Implemented, unit-tested; on the real feed `satellite_late_detections` was 0, so the late path was not exercised live | PARTIAL: limit and counter exist, live late data not demonstrated | `aggregator/src/satellite/`, metric `satellite_late_detections` | Lateness limit, counter screenshot; unit-test output for the late case |
| 4.3 | Updated or retracted detections update the existing event (including shrinking or vanishing fires) | Yes (real feed: upserts and removals) | PASS | metrics `satellite_fires_written_total{op=upsert/remove}`, reference comparison | Counter values, an example fire updated in place |
| 4.4 | Feed at 60x: no data lost, up to date within 60 s after the surge, report p95 from arrival to stored event; lag visible in the dashboard | Feed already runs at 60x. p95 <= 0.25-0.5 s. After a leader failure caught up at once. No separate artificial burst | PASS* (no artificial burst) | `p4-checks.sh` baseline and kill-leader | p95 line, lag panel screenshot |
| 4.5 | Processor dies during recognition: final result identical to an undisturbed run, no lost and no doubled fire | Yes (SIGKILL: processing again in 12-22 s; real node power-off: 57 s; reference match, contiguous log) | PASS | `p4-checks.sh` kill-leader / node-loss | Output with offsets, epoch and contiguity |
| 4.6 | Result compared with the assistants' reference; report the difference and explain | Against our own independent batch reference: 0 difference | WAITING for the assistants' reference | `satellite-tool reference` | Comparison output and explanation of any difference |
| 4.7 | Live feed processed for several minutes during the demo | Running continuously on the cluster | PASS (to be shown in the video) | metrics, dashboard | Video; dashboard screenshot |
| 4.8 | Connection drops: resume from the exact position, no loss, no duplicates | Yes (connection reset for 20 s and 90 s; same pod, log contiguous) | PASS* (in the 90 s run the stream log lines were not captured) | `p4-reconnect.sh` | Output with offsets, contiguity, "stream interrupted" log lines (20 s run) |
| 4.R | Report items: problem names (event time, watermark, late data), why M1 polling was dropped, when a fire is "recognised" and where the state is kept | n/a | Text | `docs/` satellite design | Written text |

## Problem 5: coastal sensor (C)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 5.1 | Every critical event reaches the Tim Lapangan receiver: 0 lost, p95 <= 5 s | Baseline 300/300 p95 1.59 s; leader process crash 400/400 p95 2.57 s; real leader-node power-off 300/300 delivered, p95 34 s | PASS for baseline and crash; node loss: 0 lost but p95 above 5 s (accepted as a known limit, to be stated in the report assumptions) | `p5-latency.sh` | Latency output per scenario; reliability budget |
| 5.2 | Data violating the base contract is not stored as HazardEvent but set aside with a reason | Yes: 5 injected contract-breaking items all quarantined (reasons `missing_field:*`, `out_of_range:wave_height_m`), 0 stored | PASS* (not every injected violation type is shown under its own reason) | `p5-quarantine.sh` | The Ops listing with reasons, event count before/after |
| 5.3 | While the sensor is sick, other sources keep meeting the M1 latency criteria | Yes. Sequential probes: SEISMIC p95 < 33 ms in six fault modes. The M1 k6 workload (50 VUs): a sick sensor is no worse than a healthy one, but the M1 target (p95 < 300 ms) is NOT met even with a healthy sensor (p95 1.07-1.38 s, about 55 req/s limit of the VMs) | PARTIAL: not degraded by the sensor, but the absolute M1 numbers fail at 50 VUs on these VMs | `p5-checks.sh`, `p5-m1-load.sh` | Both outputs; say it is a capacity limit |
| 5.4 | While the sensor is unhealthy, requests to it do not surge; dependent client requests answered fast with last data or an unavailable status; automatic return after recovery | Yes (8-13 requests per 40 s against 39 at baseline; reused 1-3 s after recovery) | PASS | `p5-checks.sh` | Request counts, breaker transitions, cached/unavailable answer example |
| 5.5 | Over capacity: Tim Lapangan served, Media rejected in a controlled way | Yes: Tim Lapangan got 0 HTTP 429 and all reads served; Media got 1,578 and 23,184 HTTP 429s in two runs. Our own 1 s read p95 target was missed (1.94-1.99 s) and in one run 5 of 61 field reports were refused after two attempts | PASS* for the spec wording; our 1 s target FAIL, a CPU capacity limit of the VMs (state it in the report) | `load-test/p5-priority.js`, section "P5 priority under a Media flood" | k6 output for both outcomes; the limit explained |
| 5.6 | Unannounced combination of failures; no intervention during the recovery window | Not possible before the exam (Tester Agent key is released after the deadline); individual failures tested above | WAITING | `scripts/k8s/tester-practice.sh` | Game-day output |
| 5.7 | Any member can explain a failure from dashboards, metrics and traces | Dashboards and metrics exist; one request now traces through every hop (client-api, aggregator, store, broker, consumers, ack) | PASS* (a coastal critical alert was not re-traced in Jaeger) | `docs/observability.md` | Jaeger trace screenshot, dashboard screenshots |
| 5.8 | Reliability target for the Tim Lapangan alert path and how much of it was used in the game day | Target defined; usage during the game day not available | PARTIAL / WAITING | `docs/slo.md` | Target and error-budget usage table |
| 5.R | Report items: problem names, each resilience mechanism with its values and reasons, sensor misbehaviours found, short game-day post-mortem | n/a | Text; post-mortem WAITING for the game day | `docs/slo.md`, `docs/deviations.md` | Written text |

## Platform, observability and contract (outside the problem sets)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| G.1 | Kubernetes platform: nodes, namespaces, resources, isolation, NetworkPolicy, secrets | Yes | PASS | `verify-resources.sh`, `verify-isolation.sh`, `smoke.sh` | Script output |
| G.2 | Observability: dashboards for latency, throughput, error rate per service; trace with duration per hop; structured logs with correlation ID | Dashboards and logs yes; trace through every hop now yes | PASS* (see 5.7) | `docs/observability.md` | Dashboard, trace and log screenshots |
| G.3 | Audit API contract (Appendix A): error shape, default limit, partial flag, checksum | Yes: 24 checks (errors, fields, limits, pagination, order, filters, checksum recomputed, location, unprocessed) | PASS* (`detection_keys` format and the 403 case not checked) | `audit-contract.sh` | Contract check output |
| G.4 | Tester Agent can target the cluster (spec: 3 or more nodes may allow control-plane targets) | Not possible yet; the mechanism is unknown | WAITING (ask the assistants) | `install-tester-agent.sh` | Practice-run output |
| G.5 | Bonus HPA (5 points; code and report both required) | No | NOT TESTED / optional | - | HPA scale-up and scale-down evidence |

## Deliverables

| Item | Status |
|---|---|
| Report PDF `IF4031_M2_<Group>.pdf`: general part (cover, contribution table, description, architecture, technologies, assumptions, run instructions, deployment diagram, "Perubahan dari M1", topology declaration, AI-use form), and per problem: items 1-6 | User, supervised; `docs/report-draft.md` is a draft |
| Repository: components, manifests, mocks, `.env.example`, README | README completeness (run steps, topology declaration, configuration variables, how to trigger each scenario) still open |
| Auditor results for the scenarios run before the demo | WAITING for the Audit credential |
| Video of at most 30-45 min, link sent with `POST /v1/video` | User |
| Submission form and the `milestone-2` tag | User; the tag is never created by the agent |

## What is still open

1. P2 criteria 6-8 (10,000 VU, 3x vs 1x, version swap): the kind run, last.
2. Browser check of 1.7.
3. Nothing further on P5.5 unless priority handling is added inside the aggregator.
4. G.5 bonus (optional).
5. README completeness.
6. After the deadline: official catalog, checksum, reference, Audit credential, Tester Agent key, load-test script; node-loss p95 for 5.1 stays a documented limit.
