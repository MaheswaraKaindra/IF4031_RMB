# Consistency and failure semantics per endpoint (P1 report item 4)

Unit = one shard (replica set). A unit is **available for reads** when at least one data-bearing member is a reachable primary or secondary.
"Partial" means the answer was computed without at least one unavailable unit and says so (`partial: true`, `unavailable_units`).

| Endpoint / operation | Normal | One node lost / recovering | Notes |
|---|---|---|---|
| Ingest (aggregator poll, `repo.ingest`) | Acked only after both data members of the shard hold it (`w:2`); idempotent by deterministic id | A shard with one data member cannot confirm `w:2`: after `STORE_WRITE_TIMEOUT_MS` (1.5s) the write is **acknowledged as `degraded`** (it is on the primary only; logged/counted). Network or server-selection errors stay `unavailable` (**unknown outcome**: retry the same identity, never assume failure) | Chosen so ingestion does not stop for the whole recovery window (P1 criterion 5). Cost: one durable copy until the member re-syncs, so a second loss in that window can lose those records; the system is only fault tolerant again once redundancy is restored (criterion 6). `STORE_STRICT_WRITES=1` fails closed instead (writes to affected shards return unknown outcome until re-sync) |
| Fenced write (`epoch`) | Per-record atomic: a record written under a higher epoch rejects older epochs (`stale_epoch`) | same | Protects the record itself; B must keep checkpoints/inbox in the same atomic-write pattern |
| `GET /events` (client-api -> `/internal/events`) | Newest first `(occurred_at desc, hazard_id)`; may be slightly stale (secondary reads during elections) | Complete, or `partial:true` + `unavailable_units` when a whole unit is unreachable; bounded by `STORE_DEADLINE_MS`; never 500/hang for storage loss alone | Without STORE_MODE=sharded the M1 behaviour is unchanged |
| `/internal/audit/events` | `(ingested_at, hazard_id)` ascending, keyset cursor, `next_cursor` null on the last page | same partial semantics | Cursor is **not a snapshot**: records updated between pages can move; a unit that recovers mid-scan is not retroactively included |
| `/internal/audit/checksum` | SHA-256 of byte-sorted `source_ref_id`s, `as_of` stamped | `partial:true` with a checksum over the reachable subset: never compare a partial checksum | Compare with writers quiesced (or note the `as_of`) |
| `/internal/audit/location` | Real holders (members that actually have the record), node = kubectl node name | A dead member is simply not listed; `partial` only when nothing could be read | |
| `/internal/analytics/summary` + `/analytics` | Counts logical records once (never per replica) | Counts over reachable units, banner "DATA BELUM LENGKAP" | Same numbers as a direct recount of the Audit API (the page has a button that does it) |

## Stale reads
Reads use `primaryPreferred`, read concern `local`: a secondary can lag the primary by replication delay, and after a failover a read can briefly
miss a write that was acked by `w:2` only on the old primary and not yet visible. Acked writes are not lost (both data members had them).

## Data safety vs availability
Data not lost does not mean immediately readable: a shard with no readable data member is reported unavailable until a member returns.
Permanent loss of one node never makes data unrecoverable (every shard keeps one data member elsewhere); permanent loss of two nodes does.
