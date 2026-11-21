# ADR-0001: Canonical storage for P1

| Field | Value |
|---|---|
| Date | 2026-11-16 |
| Status | **PROPOSED**: implemented, awaiting PoC gate results on the 3-VM cluster (nothing below is claimed as proven) |
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
Unit tests (ordering, cursors, partial, fencing, checksum format, Audit contract) pass locally against the in-memory reference.
Gates 1-9 need the cluster: see `poc/storage/README.md`. **Do not cite this ADR as proof until the evidence column is filled.**

| Gate | Result | Evidence |
|---|---|---|
| 1 memory | _pending_ | |
| 2 placement | _pending_ | |
| 3 node+disk loss | _pending_ | |
| 4 write path | _pending_ | |
| 5 replacement + second loss | _pending_ | |
| 6 global query | _pending_ | |
| 7 location | _pending_ | |
| 8 clock skew | _pending_ | |
| 9 analytics | _pending_ | |
