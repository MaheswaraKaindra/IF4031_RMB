# Phase 1 evidence: first real run on separate-kernel VMs (Owner A scope)

Date: 2026-11-20. Scope: A1 Kubernetes platform and A2 Problem Set 1 (distributed storage). Owners B and C are not merged,
so aggregator HA (P2), broker HA (P3) and the new sources (P4/P5) are out of scope and only reported where they showed up.

## Environment

| Item | Value |
|---|---|
| Host | one Windows PC, Intel Core i9-11900K, 32 GB RAM; VirtualBox 7.1.4 (Hyper-V backend because WSL2 is active) |
| Nodes | 3 VMs, each 4 vCPU / 7 GB RAM / 40 GB disk, Ubuntu Server 24.04, separate kernels (6.8.0-151) |
| Network | host-only 192.168.56.0/24 (cluster traffic, flannel on `enp0s8`) + NAT (internet) |
| Kubernetes | k3s v1.37.2+k3s1, every node is a server with embedded etcd (3 members), Traefik disabled |
| Store | MongoDB **4.4.30** sharded: 3 shards x (2 data + 1 arbiter), 3 config servers, 2 mongos (see "MongoDB version" below) |
| Control machine | WSL2 Ubuntu (kubectl, docker buildx, node 20.19, jq) |

Node history: `node-a`, `node-b`, `node-c` at the start. `node-b` was powered off for criterion 4 and never returned;
`node-d` (192.168.56.14) joined as a k3s server and took over node-b's store slot (criterion 5). Final nodes: a, c, d.

## Result per criterion

| # | Criterion | Result | Measured |
|---|---|---|---|
| 1 | Distribution per node, no node holds everything | PASS | 50,000 events in 83.3 s (601 writes/s, `w:2`, all applied); max node share 0.669; per node 33,688 / 33,631 / 33,451 copies |
| 2 | Skew / regional surge | PASS | 20,000 writes all in one region in 34.2 s (585/s); primary write-load ratio max/min 1.017 (writes +6,802 / +6,720 / +6,836) |
| 3 | Global query, order, pagination | PASS | 141 pages of 500 = 70,396 records, 0 duplicates, 0 order violations; 50 newest events across hazard types, 0 order violations |
| 4a | One whole shard unreachable (partial path) | PASS | 90 s outage of shard-1 through NodePorts: every audit/analytics/client answer partial with `unavailable_units=[shard-1]`, 0 unmarked answers, 0 bad answers; all records back after restore (lost=0) |
| 4b | Real VM loss (node-b powered off) | **FAIL for the aggregator-dependent paths** | see "Criterion 4 detail"; store answers stayed complete, no record lost; Audit API and client-api `/events` were down about 107 s because the single aggregator replica was on the dead node (P2, Owner B) |
| 5 | Replacement on a DIFFERENT machine | PASS | slot 2 moved from node-b to node-d; both copies of every shard equal after 67 s total (23,677 / 23,451 / 23,608); records before 70,430, after 70,738, **lost 0** |
| 6 | Survives the next loss | PASS (simulated) | slot 3 (node-c's members, PVCs deleted and recreated empty) after the replacement: 0 bad answers over 234 probes, answers complete or explicitly partial, records 70,778 before / 70,824 after, **lost 0**, redundancy restored. A real power-off of node-c was not done |
| 7 | Analytics dashboard | PASS (API level) | with shard-1 down, `/internal/analytics/summary` through NodePort 30000 returned `partial:true, unavailable_units:["shard-1"]` and `/analytics` contains the "DATA BELUM LENGKAP" banner logic. The browser rendering and the "Cocokkan dengan Audit API" button were not exercised |
| - | Placement report | PASS | `p1-report.sh`: per-member role/node/count, per-source checksums, `/internal/audit/location` returns primary and replica nodes of a record |

### Criterion 4 detail (real VM loss)

Procedure: `NODE_IP=192.168.56.11 scripts/k8s/p1-node-loss.sh 2 --manual` plus my own 1 Hz probe of three NodePorts on node-a;
node-b (aggregator, mongos, 4 store members, RabbitMQ) was hard powered off with `VBoxManage controlvm node-b poweroff` at 15:44:28 UTC.

| Event | Time after power-off |
|---|---|
| Node marked NotReady | +48 s |
| Pods on node-b evicted (20 s toleration in the demo overlay) | +68 s |
| Audit API and client-api answer again (aggregator rescheduled to node-c, Ready) | +107 s |

| Path | Probes after power-off | Failed |
|---|---|---|
| Audit API (`:30000`) | 181 | 14 (7 fast refusals, 7 hung until the 5 s probe timeout) |
| client-api `/events` (`:30080`) | 181 | 14, all fast `503` (about 2 s) |
| auth `/token` (`:30090`) | 181 | 0 |

The store stayed fully readable and no record was lost (see criterion 5, which started from the ID list saved before the loss).
The failures come from the aggregator being a single replica; it is Owner B's P2 work, so this criterion cannot pass as long as
the aggregator can sit on the killed node. The Audit API requests that hung did so because the NodePort kept routing to the dead
pod's endpoint until Kubernetes removed it.

Observation, cause not verified: in the slot-3 run, 11 consecutive probes (about 35 s) reported shard-2 as unavailable (partial) although
its other data member was running. All answers were marked partial and none failed, so the criterion holds, but `docs/consistency.md`
says one lost node leaves answers complete. Worth checking in phase 2 (a primary election after the member holding the primary was
removed is the most likely explanation).

## Platform checks

| Check | Result |
|---|---|
| etcd | 3 members healthy at the start; after node-b's loss its member was removed with `etcdctl member remove` and node-d's joined: 3 healthy members again |
| Cross-node pod networking | pods pinned to each node ping each other, 0% loss, all 9 pairs |
| NetworkPolicy enforcement | a deny-all policy blocked traffic, removing it restored it |
| Clock skew between VMs | below 15 ms (all VMs report NTP synchronized) |
| `verify-resources.sh` (live and `--manifests k8s/overlays/demo`) | all resource and role checks passed |
| `verify-isolation.sh` | passed; every store PVC is a local volume on its slot's node |
| `smoke.sh` | token to `/events` through client-api works, both sources fresh |
| Unit tests | 14 / 14 (`npm test`) |
| Adapter integration tests, sharded store | 5 / 5 (`MONGO_TEST_SHARDED=1 npm run test:mongo`), includes concurrent duplicate upsert and `mongodb@7.7` driver against 4.4 |
| `import-images.sh` | 6 images imported on 3 nodes in 1 m 46 s (and later on node-d) |
| Memory (gate 1) | after 70k records: busiest store member 160 Mi working set (limit 1 Gi), RabbitMQ 99 Mi, all pods together about 1.9 GiB; nodes 16-32% memory; no OOMKilled |

## MongoDB version: 4.4 instead of 7

The VMs expose no AVX instruction set to the guest: VirtualBox on the Hyper-V backend reports `XSAVE=0, AVX=0, AVX2=0`
(VBox.log), also when forced with `VBoxInternal/CPUM/IsaExts/AVX=1`. MongoDB 5.0 and later (including the `mongo:7` the spec names) die with
"Illegal instruction". The options were Hyper-V VMs (keeps MongoDB 7), turning off WSL2/Hyper-V, or MongoDB 4.4, the newest release
that runs without AVX. 4.4 was chosen and all numbers above come from 4.4.30. It reaches end of life in February 2024, and the spec's
baseline is "MongoDB 7", so this is a deviation to state in the report. Code changes: image tag, `mongo` shell instead of
`mongosh`, `_getEnv` instead of `process.env`, `isMaster` instead of `hello`, `count` instead of `countDocuments`, explicit `auth()`
instead of URI credentials. The application adapter and the driver needed no change.

## Bugs found and fixed

| Bug | Fix |
|---|---|
| Store crash-loops: `mongo:7` needs AVX | run on MongoDB 4.4 (commit `6211b49`) |
| RabbitMQ crash-loops after any restart or node reboot: the kubelet re-applied group-write to `.erlang.cookie` and RabbitMQ rejects a non-owner-only cookie | `fsGroupChangePolicy: OnRootMismatch` (commit `a8df39c`); two restarts verified |
| StatefulSets never replace pods that are not Ready, so an image change did not roll out to the crash-looping members | not a code bug; I deleted the 12 crash-looping pods (not their PVCs) once |
| node-d lacked the application images, so pods landing there could not start | `import-images.sh` must also run for every node added later |

## Open issues for other owners / later phases

- **B (P2):** the aggregator is one replica; its loss gives about 107 s of failed Audit API and client-api answers. Needs >= 3 replicas and leader election.
- **B (P3):** RabbitMQ is one pod with a local volume. After the permanent loss of its node it stayed `Pending` (the volume cannot move) and the consumers were not Ready; I deleted its PVC to recover, losing any queued messages.
- `p1-replace-node.sh` prints the pre-replacement node name in its "redundancy restored" line until the aggregator reloads the placement map (about 1 minute). Cosmetic.
- Real hosts: the VirtualBox VMs sometimes hang at boot with a black console and no network (seen twice, after a reboot and after a start); `VBoxManage controlvm <vm> reset` fixed it each time.

## Not done in this phase

- Tester Agent practice scenarios: the agent is installed (digest verified, 3 pods), scenarios `clock-skew kill-leader kill-store partition schema wipe-node` were only listed. Deferred to phase 2, together with the other owners' work.
- A real power-off for criterion 6, and the clean redeploy from an empty namespace.
- Gate 8 (clock skew) needs the Tester Agent.
