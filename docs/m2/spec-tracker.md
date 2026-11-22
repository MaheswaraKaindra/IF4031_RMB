# Spec tracker: IF4031 Milestone 2

One row per requirement of the official spec (`IF4031 - Tugas Besar - M2.pdf`). Status is taken only from what was measured; details and numbers are in `docs/m2/evidence/pc-run-phase2.md`.

**Status:** PASS = measured on the real 3-VM cluster and met. PASS* = met, with a limit that must be written in the report. PARTIAL = part measured or part met. NOT TESTED = no measurement yet. WAITING = needs the assistants' material (released after the deadline). FAIL = measured and not met.
**Proof:** what the report must contain for this criterion (spec: "Bukti penyelesaian per kriteria": screenshot, log excerpt with correlation ID, measurement or load-test output). "Re-run" = the user will repeat it while taking screenshots.

Last updated 2026-11-22, after the proof pass: every row that could be measured has a proof in `docs/m2/proofs/` and is in the report (`docs/milestone-2/`).

## Problem 1: storage (A2)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 1.1 | Load the assistants' historical catalog; no node holds all data; load spread over more than one node; report distribution per node | Simulated 50,000-record catalog: 155,322 records, 103.5k copies per node, max node share 0.667 | PASS* (simulated); real catalog WAITING | `proofs/1.1`, `p1-report.sh` | In the report (Figure bk-1-1) |
| 1.2 | Show how the system handles the dataset's natural skew; measure per-node load while loading and during a regional burst | Yes: 20,000 writes in one region, primaries took 8,284 / 6,983 / 6,941, max/min ratio 1.19 | PASS* (simulated) | `proofs/1.2`, `p1-hotspot.sh` | In the report (bk-1-2) |
| 1.3 | Cross-location query ("50 newest of all hazards") with pagination and correct order | Yes: 354 pages, 176,915 records, 0 duplicates, 0 order violations | PASS | `proofs/1.3`, `p1-query.sh` | In the report (bk-1-3) |
| 1.4 | Node worker killed and its data erased: no HazardEvent lost (checked through Audit API against the assistants' checksum); every request answered complete or explicitly partial, never 500 or hang | Yes: slot erased and re-synced, 52 complete + 2 explicit partial answers, 0 bad, 0 lost; a whole shard down: partial with unit name, 0 5xx. Checked against our own baseline | PASS* (official checksum WAITING; a NodePort can still reach a dead pod for about 16 s and the heavy full scans take 2-6 s) | `proofs/1.4`, `proofs/1.4-partial`, `p1-node-loss.sh`, `p1-unit-loss.sh` | In the report (bk-1-4, bk-1-4p) |
| 1.5 | New or emptied node takes over data and load without stopping writes or reads | Yes: empty-volume replacement with writes running, 496/496 writes accepted and stored, 0 duplicates, 0 lost | PASS | `proofs/1.5`, `p1-write-probe.sh` | In the report (bk-1-5) |
| 1.6 | After 1.4 and 1.5 the system survives the next node loss | Yes: slot 2 after slot 3 re-synced, 51 complete answers, 0 bad, 0 lost | PASS | `proofs/1.6` | In the report (bk-1-6) |
| 1.7 | Browser analytics dashboard: line chart per hazard type with time range, count per severity, count per area; numbers equal the Audit API; marked incomplete when a node is down | Yes: complete view, "COCOK" match (64,814 vs 64,814), incomplete banner naming shard-1 during an outage, green again after | PASS | `proofs/1.7`, `proofs/1.7-partial` | In the report (bk-1-7a to d) |
| 1.R | Report items: problem name and concept, mechanism and placement rule, two alternatives, per-endpoint consistency, how dashboard numbers are computed and flagged | n/a | Text, user-supervised | `docs/m2/decisions/ADR-0001-storage.md` | Written text |

## Problem 2: coordination (B)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 2.1 | At least 3 instances on different nodes behind one entry point that stops routing to unhealthy ones | Yes: 5 pods on 3 nodes, 30/30 requests via NodePort | PASS | `proofs/2.1`, `p2-placement.sh` | In the report (bk-2-1) |
| 2.2 | Every source fetched exactly once; no duplicate HazardEvent; upstream sees no multiplied requests (upstream log) | Yes: 178,940 records, 0 duplicates, one caller per mock | PASS | `proofs/2.2`, `p2-single-fetch.sh` | In the report (bk-2-2) |
| 2.3 | Fetcher dies: another instance continues within 60 s, no gap, no duplicate | Yes: real power-off, takeover in 15.8 / 21.0 / 21.6 / 22.1 s, 0 duplicates, no gap | PASS | `proofs/2.3`, `p2-failover.sh` | In the report (bk-2-3) |
| 2.4 | Clock shifted (+45 s, then -30 s): never two instances saving in the same period | Yes: never two valid leaders in 95 rounds, 25 mock events all stored | PASS | `proofs/2.4`, `p2-clock-skew.sh` | In the report (bk-2-4) |
| 2.5 | Leader frozen longer than the limit, wakes up: stores nothing until its status is refreshed | Yes: woken instance stopped leading after about 1 s, 0 upstream polls | PASS | `proofs/2.5`, `p2-freeze.sh` | In the report (bk-2-5) |
| 2.6 | Sustained load of at least 10,000 VU for at least 120 s while instances go 3 -> 5 -> 2; error rate outside controlled rejection below 1%, criterion 2 still holds | Yes with a custom async generator (k6 cannot hold 10,000 VUs here): 10,000 users all active for 200 s, 24,927 requests, 1 error (0.004%), p95 254 ms | PASS* (light load per user, about 71 req/s; the VMs' limit is about 100 req/s: a run at about 100 req/s gave 1.13% errors) | `proofs/2.6`, `p2-load-10k.sh`, `vu-sim.mjs` | In the report (bk-2-6) |
| 2.7 | Throughput with 3 instances at least 2.0x one instance | Uncapped the shared host CPU is the bottleneck (about 0.9x, hardware limit of the single test PC). With a CPU limit of 250 m per pod: 5.28x (8.1 vs 42.8 successful req/s; the single instance fails 58%) | PASS* only under the CPU cap; uncapped limited by the single test PC | `proofs/2.7`, `p2-throughput-capped.sh` | In the report (bk-2-7), limit stated |
| 2.8 | Version swap during the load test without a failed request | Yes: rolling update at t=260 s of the 10,000-user run, 0 failures | PASS | `proofs/2.6` | In the report (2.6 figure) |
| 2.R | Report items: problem names, time source and why safe for 2.4 and 2.5, lease/timeout values and trade-off, load-test configuration | n/a | Text | `docs/m2/p2-p3-design.md` | Written text |

## Problem 3: schema change and field reports (B)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 3.1 | Declare what is accepted automatically and what is not; behaviour matches on the PVMBG mock | Yes: additive accepted; rename, type and missing parked (14 each) | PASS | `proofs/3.1`, `p3-checks.sh` (31 checks) | In the report (bk-3-1) |
| 3.2 | Unprocessable messages kept whole with reason, source, time; retryable and non-retryable treated differently | Yes | PASS | `proofs/3.1` | In the report (bk-3-1) |
| 3.3 | Corrupt messages (truncated JSON, deep nesting, bad UTF-8, oversized) crash nothing; other data keeps flowing | Yes: kept byte-identical, 0 restarts, BMKG kept flowing | PASS | `proofs/3.1` | In the report (bk-3-1) |
| 3.4 | After adapting to the schema change, replay: everything recovered, no duplicate, per-`source_ref_id` order kept | Yes: 14 recovered, 2nd replay recovers nothing, 0 duplicates; order kept and a key blocks behind an unreadable version | PASS | `proofs/3.1`, `proofs/3.4`, `p3-order.sh` | In the report (bk-3-4) |
| 3.5 | Only BNPB Internal Ops can inspect failed messages | Yes: 403 for Media and Field, 200 for Ops | PASS | `proofs/3.1` | In the report (bk-3-1) |
| 3.6 | `POST /field-reports` answers 202 quickly even when downstream is slow or dead; receiver may die after the 202; no 202'd report lost or processed twice | Yes: broker down and all aggregators killed, 20/20; node power-off, 275/275 on the first attempt, 0 duplicates | PASS | `proofs/3.1`, `proofs/3.6` | In the report (bk-3-6) |
| 3.R | Report items: names, schema policy and reasons, store/inspect/replay and duplicate prevention, delivery guarantee on the field-report path with proof | n/a | Text | `docs/m2/p2-p3-design.md` | Written text |

## Problem 4: satellite feed (C)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 4.1 | Hotspots become WILDFIRE HazardEvents per the definition; one fire seen by several satellites = one event | Yes (real feed, 1.94M frames): 30,489 fires, 0 missing, 0 extra, 0 different against an independent batch computation | PASS | `proofs/4.1` | In the report (bk-4-1) |
| 4.2 | Grouped by detection time, not arrival time; stated lateness limit; late detections within the limit still update the fire; later ones not dropped silently and counted | 35 unit tests with injected late detections pass; the live feed produced none (counter 0) | PARTIAL: limit and counter exist, live late data not demonstrated | `proofs/4.2` | In the report (bk-4-2), say it is injected |
| 4.3 | Updated or retracted detections update the existing event (including shrinking or vanishing fires) | Yes: 38,881 retractions applied in the reference comparison, 0 differences | PASS | `proofs/4.1` | In the report (bk-4-1) |
| 4.4 | Feed at 60x: no data lost, up to date within 60 s after the surge, report p95 from arrival to stored event; lag visible in the dashboard | Feed runs at 60x; p95 <= 0.25 s; a 90 s feed cut: up to date 2 s after reconnecting, log contiguous; Grafana lag panel shows the surge | PASS* (the surge is a backlog, not a faster feed) | `proofs/4.4-baseline`, `4.4-backlog`, `4.4` | In the report (bk-4-4a to c) |
| 4.5 | Processor dies during recognition: final result identical to an undisturbed run, no lost and no doubled fire | Yes: SIGKILL, processing again in 6 s, epoch 298 -> 299, offset only forward, log contiguous | PASS | `proofs/4.5` | In the report (bk-4-5) |
| 4.6 | Result compared with the assistants' reference; report the difference and explain | Against our own independent reference: 0 difference | WAITING for the assistants' reference | `proofs/4.1` | `\isian` left in the report |
| 4.7 | Live feed processed for several minutes during the demo | Yes: three snapshots a minute apart, offsets moving, lag 0; Grafana dashboard | PASS (also shown in the video) | `proofs/4.7` | In the report (bk-4-7a, b) |
| 4.8 | Connection drops: resume from the exact position, no loss, no duplicates | Yes: connection reset for 20 s, same pod, offset only forward, log contiguous (1,980,952 frames) | PASS | `proofs/4.8`, `p4-reconnect.sh` | In the report (bk-4-8) |
| 4.R | Report items: problem names (event time, watermark, late data), why M1 polling was dropped, when a fire is "recognised" and where the state is kept | n/a | Text | `docs/` satellite design | Written text |

## Problem 5: coastal sensor (C)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| 5.1 | Every critical event reaches the Tim Lapangan receiver: 0 lost, p95 <= 5 s | Baseline 300/300 p95 1.74 s; leader process crash 400/400 p95 4.45 s (16 over 5 s); real leader-node power-off 0 lost but p95 about 34 s | PASS for baseline and crash; node loss: documented limit | `proofs/5.1-baseline`, `5.1-crash` | In the report (bk-5-1a, b), limit stated |
| 5.2 | Data violating the base contract is not stored as HazardEvent but set aside with a reason | Yes: 5 injected items quarantined with reasons, 0 stored | PASS* (not every violation type is shown under its own reason) | `proofs/5.2` | In the report (bk-5-2) |
| 5.3 | While the sensor is sick, other sources keep meeting the M1 latency criteria | Yes at 4 users: SEISMIC p95 169 / 155 / 133 ms (normal, slow, blackhole); six fault modes p95 47-80 ms. At 6 users 235-321 ms; at 50 users the M1 target is not met even with a healthy sensor | PASS* (scaled-down workload) | `proofs/5.3`, `proofs/5.4` | In the report (bk-5-3), limit stated |
| 5.4 | While the sensor is unhealthy, requests to it do not surge; dependent client requests answered fast with last data or an unavailable status; automatic return after recovery | Yes: 7-12 requests per 40 s against 38, answers in 44-59 ms, reused 1-4 s after recovery, 25 checks | PASS | `proofs/5.4` | In the report (bk-5-4) |
| 5.5 | Over capacity: Tim Lapangan served, Media rejected in a controlled way | Yes with the Media ceiling lowered to 4 per pod: 16,889 Media 429s, Tim Lapangan 452 served and 0 rejected, 120/120 reports, p95 981 ms. At the default ceiling and 100 Media users p95 is about 1.9 s | PASS* (artificial ceiling; capacity limit of the VMs) | `proofs/5.5` | In the report (bk-5-5), limit stated |
| 5.6 | Unannounced combination of failures; no intervention during the recovery window | Not possible before the exam (Tester Agent key is released after the deadline); individual failures tested above | WAITING | `scripts/m2/tester-practice.sh` | `\isian` left in the report |
| 5.7 | Any member can explain a failure from dashboards, metrics and traces | Yes: a field report (9 spans) and a coastal alert (20 spans) trace through every hop with the correlation ID; Grafana dashboards | PASS | `proofs/5.7*` | In the report (bk-5-7a to e) |
| 5.8 | Reliability target for the Tim Lapangan alert path and how much of it was used in the game day | Target defined; usage during the game day not available | PARTIAL / WAITING | `docs/m2/slo.md` | `\isian` left in the report |
| 5.R | Report items: problem names, each resilience mechanism with its values and reasons, sensor misbehaviours found, short game-day post-mortem | n/a | Text; post-mortem WAITING for the game day | `docs/m2/slo.md`, `docs/m2/deviations.md` | Written text |

## Platform, observability and contract (outside the problem sets)

| ID | Requirement | Tested | Status | Evidence / script | Proof for the report |
|---|---|---|---|---|---|
| G.1 | Kubernetes platform: nodes, namespaces, resources, isolation, NetworkPolicy, secrets | Yes: 164 checks, all passed | PASS | `proofs/G.1` | In the report (bk-g-1) |
| G.2 | Observability: dashboards for latency, throughput, error rate per service; trace with duration per hop; structured logs with correlation ID | Yes: log lines with one correlation ID in client-api and aggregator, overview dashboard, traces | PASS | `proofs/G.2`, `proofs/G.2-log` | In the report (bk-g-2a, b) |
| G.3 | Audit API contract (Appendix A): error shape, default limit, partial flag, checksum | Yes: 22 checks passed | PASS* (`detection_keys` format and the 403 case not checked) | `proofs/G.3`, `audit-contract.sh` | In the report (bk-g-3) |
| G.4 | Tester Agent can target the cluster (spec: 3 or more nodes may allow control-plane targets) | Not possible yet; the mechanism is unknown | WAITING (ask the assistants) | `install-tester-agent.sh` | Practice-run output |
| G.5 | Bonus HPA (5 points; code and report both required) | Yes: client-api 2 -> 6 -> 2 and aggregator 3 -> 6 -> 3 replicas with the load; scale-down 169 s after the load | PASS (bonus) | `proofs/H.1`, `hpa-ramp.sh`, `k8s/overlays/demo/hpa.yaml` | In the report (bonus section, table and figures) |

## Deliverables

| Item | Status |
|---|---|
| Report PDF `IF4031_M2_<Group>.pdf` | LaTeX sources in `docs/milestone-2/` have every required section and the proofs; three `\isian` markers remain for items that need the assistants (4.6, 5.6, 5.8). The PDF must be recompiled (`python compile.py`); the AI-use form and the links section (add all proof logs) are for the user |
| Repository: components, manifests, mocks, `.env.example`, README | Done; the README lists every test script and setting |
| Auditor results for the scenarios run before the demo | WAITING for the Audit credential |
| Video of at most 30-45 min, link sent with `POST /v1/video` | User |
| Submission form and the `milestone-2` tag | User; the tag is never created by the agent |

## What is still open

1. **Needs the assistants (after the deadline):** real catalog and checksum (1.1, 1.4), their satellite reference (4.6), the Audit credential, the Tester Agent key and game day (5.6, 5.8), the load-test script, and how the Tester Agent may target control-plane nodes (G.4).
2. **Limits of the test hardware (3 VMs on one PC), stated in the report:** 2.7 (3 vs 1 instances only under a CPU cap), 5.1 (node-loss p95 about 34 s), 5.3 (M1 target at 50 users), 5.5 (artificial Media ceiling), the 100 req/s capacity of the VMs, 4.2 (late path unit-tested only).
3. **Yours:** recompile the PDF, the AI-use form, the links section with all proof logs, the video, the submission form and the `milestone-2` tag.
