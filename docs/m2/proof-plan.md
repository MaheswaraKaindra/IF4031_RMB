# Proof plan for the report

What still has to be captured for the report, one row per tracker criterion (`docs/m2/spec-tracker.md`). Every proof must be a **passing** one. Where the plain test does not pass, the plan uses an **artificial case** (a reduced load, a resource cap, an injected input) and the report must say so in one sentence next to the proof.

**Form:** Text = script output or log excerpt that the agent can capture to `docs/m2/proofs/<id>/` and the team pastes into the report. Shot = screenshot taken by a person in a browser or terminal.
**Platform:** VM = must be the 3-VM k3s cluster (real kernels, clocks, power). Kind OK = the check does not depend on separate kernels or hardware, so a kind cluster could give it, but only if the kind setup is first made to work (the earlier kind attempt failed) and the assistants accept kind proofs; until then use VM for everything.
**ETA:** hands-on minutes including setup and a re-run if the first run is not clean; most of it is waiting. Trial = the passing parameters are not known yet and need one or two trial runs.

## Before taking proofs (once, about 30 min)

1. Start the three VMs, wait for 3 Ready nodes, all pods Ready, `redundancy_ok`, and no `wtimeout` in the aggregator logs for 3 minutes.
2. Decide on cleaning the test records (`WP-`, `k6-`, `FR-P3-`, `trace-`) so dashboards and counts are clean (needs the user's OK).
3. Run `git log -1` and note the commit; every proof file records the commit and the date.
4. After every real power-off wait until the node is Ready and the store is re-synced (about 5 minutes).

## P1

| ID | Passing proof to take | Artificial case to explain | Form | Platform | ETA |
|---|---|---|---|---|---|
| 1.1 | `p1-load.sh` / `p1-report.sh`: records per node and write counters, no node holds all data | Simulated catalog (the real one comes after the deadline) | Text | VM | 15 min |
| 1.2 | `p1-hotspot.sh`: per-node load while loading and during the Sumatra burst, max/min ratio < 2 | Simulated catalog and burst | Text | VM | 15 min |
| 1.3 | `p1-query.sh`: 50 newest across all hazards, pagination, order | none | Text | VM or kind OK | 10 min |
| 1.4 | `p1-node-loss.sh 3` (members stopped, volumes erased, empty volumes re-sync): lost = 0, 0 bad answers; `p1-unit-loss.sh 1` for the explicit partial answer | The loss is simulated by erasing volumes, not by powering off (a real power-off showed a window of failed requests, see the limit note) | Text | VM | 30 min |
| 1.5 | `p1-write-probe.sh 270 "scripts/m2/p1-node-loss.sh 3"`: writes accepted and all stored during the re-sync | none | Text | VM | 25 min |
| 1.6 | `p1-node-loss.sh 2` right after 1.5 has re-synced: lost = 0 | same simulated loss | Text | VM | 30 min |
| 1.7 | Dashboard with the 24 h range: green "complete" banner, three views, "Cocokkan dengan Audit API" match; then during `p1-unit-loss.sh 1` the incomplete banner naming the unit; then the green banner again | 24 h range (all-time exceeds the 8 s scan budget and is marked incomplete); test records cleaned | Shot (3-4) + Text (Audit numbers) | VM | 25 min |

## P2

| ID | Passing proof to take | Artificial case to explain | Form | Platform | ETA |
|---|---|---|---|---|---|
| 2.1 | `p2-placement.sh` and `kubectl get pods -o wide` | none | Text | VM or kind OK | 5 min |
| 2.2 | `p2-single-fetch.sh`: 0 duplicates, one upstream caller (mock log) | none | Text | VM or kind OK | 10 min |
| 2.3 | `p2-failover.sh` (real power-off of the leader's node, limit 60 s) | none | Text | VM | 20 min |
| 2.4 | `p2-clock-skew.sh` (+45 s then -30 s on a node) | none | Text | VM only (kind shares one clock) | 15 min |
| 2.5 | `p2-freeze.sh` (VM paused, resumed) | none | Text | VM only | 10 min |
| 2.6 | `p2-load-10k.sh` with `THINK_S=140 DURATION_S=340`: 10,000 users, scaling 3->5->2->3, 0 errors, criterion 2 intact | Custom asynchronous generator (k6 cannot hold 10,000 VUs here) and a light rate of about 71 req/s per the VM capacity; the run at about 100 req/s is not used | Text | VM | 20 min |
| 2.7 | Throughput 1 vs 3 aggregator instances with a CPU limit of 250 m per pod, at a VU level where the single instance still mostly answers | The CPU cap is artificial (uncapped, the host CPU is the bottleneck and the ratio is about 0.9x); state the cap, the failure rates, and the uncapped result | Text | VM | 40 min (Trial: pick the VU level) |
| 2.8 | Rolling update during the 10,000-user run (same output as 2.6, the `t=...` line and 0 errors) | same as 2.6 | Text | VM | included in 2.6 |

## P3

| ID | Passing proof to take | Artificial case to explain | Form | Platform | ETA |
|---|---|---|---|---|---|
| 3.1-3.3, 3.5, 3.6 | `p3-checks.sh` (33 checks): declaration, parked messages with reason, corrupt payloads, Ops-only access, durable 202 with the broker down | none | Text | VM or kind OK | 15 min |
| 3.4 | `p3-checks.sh` replay part and `p3-order.sh` (5 checks) | Versions of one report are placed in the inbox directly (the mock cannot serve several versions) | Text | VM or kind OK | 10 min |
| 3.6 (continuity) | `p1-write-probe.sh` through a power-off: all writes 202 and stored | none | Text | VM | 15 min |

## P4

| ID | Passing proof to take | Artificial case to explain | Form | Platform | ETA |
|---|---|---|---|---|---|
| 4.1, 4.3 | `satellite-tool reference` (0 missing, 0 extra, 0 different) and the upsert/remove counters | Our own independent recomputation (the assistants' reference comes after the deadline) | Text | VM | 20 min (the comparison takes minutes) |
| 4.2 | Late detections: show the lateness limit, the late counter, and a case where a late detection within the limit updates a fire and one beyond it is counted, not dropped | The live feed produced no late detections, so use the unit test output or an injected late frame; state that it is injected | Text | VM or kind OK | 40 min (Trial: check what the tool can inject) |
| 4.4 | `p4-checks.sh` baseline (p95 at the feed's own 60x) and `p4-reconnect.sh` with `CUT_S=90` (backlog built during the cut, caught up in seconds); dashboard lag panel | The surge is a built-up backlog, not a faster feed | Text + Shot (lag panel) | VM | 15 min |
| 4.5 | `p4-checks.sh` with `SCENARIO=kill-leader`: new leader, offset forward only, epoch up, log contiguous | none | Text | VM | 10 min |
| 4.7 | Live stream running for several minutes: dashboard and counters | none | Shot (dashboard) + video | VM | 10 min |
| 4.8 | `p4-reconnect.sh` with `CUT_S=20` (logs show the interruptions) | The cut is made with a firewall rule on the node | Text | VM | 10 min |

## P5

| ID | Passing proof to take | Artificial case to explain | Form | Platform | ETA |
|---|---|---|---|---|---|
| 5.1 | `p5-latency.sh` baseline (p95 1.6 s) and leader-process crash (p95 2.6 s); node loss of a node that does NOT hold the coastal leader, with 0 lost and p95 within 5 s | The node-loss case that hits the coastal leader gives p95 34 s (30-38 s handover) and is not shown as a pass; state it as a limit in the assumptions | Text | VM | 30 min (Trial: confirm the non-leader case) |
| 5.2 | `p5-quarantine.sh`: bad items listed with reasons, none stored | Bad items are injected through the fake sensor | Text | VM or kind OK | 10 min |
| 5.3 | M1 workload (`p5-m1-load.sh`) at a reduced user count where SEISMIC p95 < 300 ms with the sensor in slow and blackhole modes, plus `p5-checks.sh` (six fault modes) | The M1 workload is scaled down (the VMs cannot meet 300 ms at 50 VUs even with a healthy sensor); state the user count | Text | VM | 45 min (Trial: find the user count) |
| 5.4 | `p5-checks.sh`: requests to the sensor do not surge, answers fast, automatic recovery | none | Text | VM | 15 min |
| 5.5 | `load-test/p5-priority.js` at a load where Tim Lapangan stays under 1 s and field reports are all accepted, with Media rejected by 429 | Reduced Media and field VUs (at 100 Media VUs the VMs run out of CPU); state the VUs | Text | VM | 45 min (Trial: find the VUs) |
| 5.6, 5.8 | Game day and error-budget usage | Waiting for the Tester Agent exam key; until then a practice run with `tester-practice.sh` | Text | VM | After the deadline |
| 5.7 | Jaeger trace of a field report and of a coastal critical alert; Grafana panels explaining a failure | none | Shot (trace and dashboards) + Text (span table) | VM | 30 min |

## Platform and contract

| ID | Passing proof to take | Artificial case | Form | Platform | ETA |
|---|---|---|---|---|---|
| G.1 | `verify-resources.sh`, `verify-isolation.sh`, `smoke.sh` | none | Text | VM or kind OK | 10 min |
| G.2 | Grafana dashboards (latency, throughput, error rate per service), a log line with a correlation ID, a Jaeger trace | none | Shot | VM | 30 min |
| G.3 | `audit-contract.sh` (24 checks) | none | Text | VM or kind OK | 5 min |
| G.5 | HPA ramp up and down: replica counts over time while the load rises and falls (optional bonus, needs the code and report text) | A ramped load, not a real surge | Text + Shot (replica graph) | VM | 40 min |

## Order and totals

1. Pre-checks (30 min), then P1 (about 2.5 h, including 1.6), then P2 (about 2 h), P3 (about 40 min), P4 (about 1.7 h), P5 (about 3.5 h including trials), platform and screenshots (about 1.2 h).
2. Total for the VM cluster: about 12 hours of hands-on time, of which about 4 hours are trial runs to find passing parameters (2.7, 4.2, 5.1, 5.3, 5.5). Add 40 min for the optional HPA bonus.
3. Screenshots needed from a person (about 15 images): 1.7 (3-4), Grafana panels (lag, latency/throughput/error rate, leader and epoch, store), the Jaeger traces (2), optionally `kubectl get pods -o wide`.
4. After the deadline, when the assistants release their material: real catalog and checksum (1.1, 1.4), their satellite reference (4.6), the Audit credential, the Tester Agent key and game day (5.6, 5.8); ask how the Tester Agent may target control-plane nodes (G.4).

## Kind

All rows marked "Kind OK" are logic checks that kind could give, but the kind cluster has not been made to work (the earlier attempt failed at `store-init` and kube-proxy opened too many files) and the spec allows kind for development only. Do not mix kind and VM proofs in one table; if a kind proof is used, label it as kind in the report. Clock skew, freeze, real power-off, node loss and re-sync need the VMs.
