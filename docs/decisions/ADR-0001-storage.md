# ADR-0001: Canonical storage for P1

| Field | Value |
|---|---|
| Date | 2026-11-16 |
| Status | **PROPOSED**: implemented and measured on the 3-VM cluster on MongoDB 4.4 (gate 9 partial; see Evidence status and `docs/evidence/pc-run-phase2.md`) |
| Owner | A |
| Revisit trigger | Any gate in `poc/storage/README.md` fails, the demo grows to >= 4 nodes, or the assistants rule differently on arbiter/config-server classification |

## Context
P1 needs: >= 2 copies of every record, no node holding the whole dataset, survival of permanent loss of one node and its
disk, recovery to a state that survives the NEXT loss, complete-or-explicitly-partial answers, global ordering/pagination, rebalancing
without stopping reads or writes. Pods are limited to 512Mi request / 1Gi limit. Final demo: **3 nodes with separate kernels** (decision of the team, 2026-11-16).

## Topology arithmetic (why the usual layouts fail)
With R copies spread over N nodes, "no node holds everything" needs every node to miss at least one record; survival of one node loss needs R >= 2.
* 2 nodes: R=2 puts everything on both. Impossible, regardless of database.
* 3 nodes, textbook 3-member replica set per shard: every node holds every shard, i.e. the whole dataset. Fails.
* 3 nodes, CockroachDB: RF=3 is the same problem; RF=2 loses range quorum on one node loss (blocked reads and writes).

## Decision (proposed)
MongoDB sharded cluster, **3 shards, each = 2 data members + 1 arbiter, rotated over the 3 node slots**, 3 config servers (one per slot),
2 mongos. Shard key `{_id: hashed}` where `_id = hazard_id = hash(source, source_ref_id)`.

| Slot | Data members | Arbiter | Config |
|---|---|---|---|
| 1 | shard-1 a, shard-3 b | shard-2 | cfg-1 |
| 2 | shard-2 a, shard-1 b | shard-3 | cfg-2 |
| 3 | shard-3 a, shard-2 b | shard-1 | cfg-3 |

Each node stores 2 of 3 shards (about 2/3 of the dataset, never all of it). Losing any node leaves >= 1 data member of every shard.
Generated from one rule by `k8s/store/generate.mjs`.

## Key choices and trade-offs
| Choice | Why | Cost / risk |
|---|---|---|
| Hashed shard key on a deterministic id | Spreads the geographically skewed catalog evenly (placement is by identity, not location); `_id` uniqueness is global without a cross-shard unique index (unique indexes must be shard-key prefixed) | Range queries by location scatter-gather to all shards; **needs Owner B's agreement** that `hazard_id` is deterministic (default applied, open decision O-1) |
| Write concern `w:2`, 1.5s timeout, degraded ack | The implicit default is `w:1` and `w:majority` cannot be acknowledged by a primary + arbiter pair with a member down; plain `w:1` would silently run on one copy even when healthy | With a member down the write is acknowledged `degraded` (primary only) so ingestion continues; those records have ONE copy until re-sync. `STORE_STRICT_WRITES=1` fails closed instead. Trade-off: availability of writes vs durability during the degraded window |
| Arbiters | Elections with only 2 data members | Cannot acknowledge writes; in a degraded shard the majority commit point stalls and cache pressure grows: gate 1 must be measured with a member down |
| Reads via mongos, `primaryPreferred`, `allowPartialResults` | Correct results during chunk migration (orphan filtering); reads continue from a secondary during an election | Possible stale reads (documented in `docs/consistency.md`) |
| Per-member probes (`hello`) for `unavailable_units` | Names the unreachable unit with a bounded deadline | Unit = shard; a shard counts available if any data member is readable |
| Empty-disk rejoin as the "new node" case | Allowed by P1 criterion 5 ("or the same node with an empty disk"); replica initial sync restores redundancy automatically | Adding a 4th node as extra capacity (new shard + balancer) is documented but not automated |
| Direct member reads only for placement/probe | `/audit/location` must show real holders | Never used for data answers: direct reads can return orphaned documents |

## Alternatives considered
| Alternative | Verdict |
|---|---|
| CockroachDB | Eliminated on 3 nodes (see arithmetic). `poc/storage/cockroach-mem.sh` documents memory behaviour; reopen at >= 4 nodes |
| 3-member replica set per shard (standard) | Violates "no node holds the whole dataset" |
| 2 shards (rotated) | A node would hold both shards |
| App-level sharding over standalone replica sets, no mongos | Fewer pods but no balancer, own resharding code, orphan-safety becomes our problem |
| Geographic/range shard key | Matches the hotspot problem (one region = one shard) and sequential ids hot-spot one chunk. Rejected for placement; hashing evens it out |

## Evidence status
Measured on 2026-11-20 on 3 separate-kernel VMs (details, commands and numbers: `docs/evidence/pc-run-phase1.md`).
Deviation: the VMs expose no AVX, so the store runs on **MongoDB 4.4.30**, not the MongoDB 7 named in the spec (see the evidence
file); every result below is for 4.4. Consequence for the code base: no aggregation operator newer than 4.4 may be used (the coastal ledger's `$dateAdd` had to be replaced). Revisit this ADR if the demo moves to hardware or Hyper-V VMs that expose AVX.

| Gate | Result | Evidence |
|---|---|---|
| 1 memory | PASS (snapshot) | after 70k records the busiest store member used 160 Mi working set under the 1 Gi limit, no OOMKilled; a peak sweep under sustained load was not run |
| 2 placement | PASS | 50,000 events: max node share 0.669; one-region burst of 20,000: primary write ratio 1.017 |
| 3 node+disk loss | PASS for the store, FAIL for aggregator-dependent paths | store stayed complete or explicitly partial, 0 records lost on three runs; a real power-off of the node holding the single aggregator replica gave about 107 s of failed Audit API / client-api answers (P2, Owner B) |
| 4 write path | PASS | unit and adapter tests pass (5/5 on the sharded store, concurrent duplicate upsert applied once); during real node losses writes continued as `degraded` acknowledgements with 0 records lost and no false acknowledgement; coordination and inbox bookkeeping now follows the same degraded rule (phase 2) |
| 5 replacement + second loss | PASS | node-b replaced by node-d (a different VM), 67 s to equal copies, lost 0; then slot 3 lost and recovered, lost 0 (the second loss was simulated, not a real power-off) |
| 6 global query | PASS | 70,396 records paged, 0 duplicates, 0 order violations |
| 7 location | PASS | `/internal/audit/location` returns primary and replica node of a record |
| 8 clock skew | PASS (own script) | `p2-clock-skew.sh`: leader node clock +45 s then -30 s, the store kept serving, 0 duplicates, 0 records lost; the official Tester Agent `clock-skew` scenario found no eligible target (see `docs/evidence/pc-run-phase2.md`) |
| 9 analytics | PARTIAL | numbers and the partial flag verified through the API and NodePort 30000; browser banner and the compare button not exercised |
