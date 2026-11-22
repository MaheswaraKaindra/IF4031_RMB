# Milestone 2 deviations and verification gaps

| Area | Deviation or verification gap |
|---|---|
| P1 storage | The three VirtualBox guests lack AVX and run MongoDB 4.4.30. The healthy store confirms writes on two data members. In degraded mode an acknowledged write can have one copy until replication catches up. The replacement exercise restored an existing slot. Adding a fourth node as a new shard is a manual operation. The CockroachDB comparison reached the topology and memory smoke-test stage. |
| P2 coordination | A record write checks the source epoch before the write and fences existing records against the epoch stored on that record. The check and write are separate operations. A stale create can be visible before compensating removal. VM tests observed zero overlapping leaders, duplicates or lost records in the sampled runs. |
| P2 load and scale | The controlled scaling run used 60 requests/s. The 10,000 VU test and the 2× throughput target remain undemonstrated on the three-VM host. |
| P3 reliability | Byte-identical preservation was verified for malformed whole bodies. In a parsed batch, individually parked records are serialized again. Consumer deduplication is local and ephemeral. The durable field-report outbox and critical alert ledger cover their own delivery paths. |
| P4 satellite | Fire IDs are derived from the earliest detection key. A correction that changes the earliest detection can change the fire ID. The batch reference comparison and recovery runs verified the resulting fire set and feed continuity. |
| P5 timing and priority | Baseline and leader-process crash met p95 ≤5 s. A real node loss created a 30–38 s coastal handover gap. All 300 alerts were acknowledged, and 196 missed the deadline. Tim Lapangan admission reserves capacity at client-api ingress. The idle-cluster Media flood still exceeded the field-team read threshold (1.88 s p95) and refused 2 of 107 field reports. |
| Tester Agent and game day | The `schema` practice scenario passed. The other five found no eligible target on the all-control-plane topology. Combined-fault game day is unverified. |
| Observability and UI | The mocks, store, broker and sensor do not emit spans. Analytics was checked at API and HTML level. Browser interaction is unverified. |

See [Phase 1 evidence](evidence/pc-run-phase1.md), [Phase 2 evidence](evidence/pc-run-phase2.md), and the [storage decision](decisions/ADR-0001-storage.md).
