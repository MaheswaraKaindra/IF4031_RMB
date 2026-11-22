# Storage PoC (decision D1)

Goal: decide MongoDB-sharded vs CockroachDB with measurements, not preference. The decision record is
`docs/m2-details/decisions/ADR-0001-storage.md`; this directory holds the harness.

| Gate | What | Where it runs | Command |
|---|---|---|---|
| 1 memory | peak RSS under the official 1Gi limit, no OOM | MacBook (indicative) + demo VMs (record) | `poc/storage/mongo-mem.sh`, `poc/storage/cockroach-mem.sh` |
| 2 placement | no node holds everything; per-node counts; hotspot write load | 3-VM cluster | `scripts/m2/p1-load.sh`, `scripts/m2/p1-hotspot.sh` |
| 3 node+disk loss | zero lost records (containment, not checksum equality: ingestion continues), no 5xx/hang | 3-VM cluster | `scripts/m2/p1-node-loss.sh <slot>`; partial path: `scripts/m2/p1-unit-loss.sh <shard>` |
| 4 write path | `w:2` + timeout, no false ack, unknown outcome on timeout | 3-VM cluster | unit tests (`npm test` in aggregator) + node-loss run with writers |
| 5 replacement + 2nd loss | empty-disk node re-syncs, then another loss survives | 3-VM cluster | `p1-node-loss.sh 1` then `p1-node-loss.sh 2` |
| 6 global query | `(ingested_at,hazard_id)` / `(occurred_at desc,hazard_id)` paging | 3-VM cluster | `scripts/m2/p1-query.sh` |
| 7 location | hazard_id -> shard/node/role | 3-VM cluster | `scripts/m2/p1-report.sh` |
| 8 clock skew | storage keeps serving with a skewed node clock | 3-VM cluster + Tester Agent | `kubectl exec -n tester-agent daemonset/tester-agent -- /app list` then a clock scenario |
| 9 analytics | dashboard numbers == Audit API; partial banner | browser | `http://<node>:30000/analytics`, button "Cocokkan dengan Audit API" |

## Why CockroachDB is a smoke test only on 3 nodes
Raft needs a majority of replicas. RF=3 on 3 nodes puts a full copy on every node (violates "no node stores the whole
dataset"); RF=2 leaves a range without quorum after one node loss (reads and writes blocked). With >= 4 nodes RF=3 spreads
copies and the full comparison becomes meaningful: re-open ADR-0001 in that case.

## Expected cost of the Mongo layout (to be confirmed by gate 1 and `kubectl top`)
3 shards x (2 data + 1 arbiter) + 3 config servers = 12 `role=store` pods at 512Mi request each, plus 2 mongos.
Per node: 4 store pods = 2Gi of requests. See `docs/m2-details/topology.md` for the full RAM budget.
