# P2 and P3 design: aggregator coordination and messaging

Written from the implementation (`aggregator/src/coordination`, `aggregator/src/p3`) and the measurements in `docs/m2-details/evidence/pc-run-phase2.md`.
It answers the "Di laporan" questions of Problem Sets 2 and 3, and states every trade-off and limit.

## P2: running several aggregator instances without fetching twice

### Problem
With three or more aggregator replicas behind one Service, each polled source (BMKG, PVMBG, and later the satellite feed and the coastal sensor) must be
fetched by **one** instance at a time. Two active fetchers double the upstream load and can store the same event twice; none means a gap.
Textbook names: leader election with leases, fencing tokens (a monotonic epoch), and write-ahead checkpoints.

### Mechanism
| Part | What it does | Where |
|---|---|---|
| Lease per source | A Kubernetes `Lease` object per source (`aggregator-poller-bmkg`, `-pvmbg`, `aggregator-satellite`, `aggregator-coastal`). The holder renews it; others wait. Duration 20 s, renew deadline 12 s, retry 3 s (coastal 8 s, 5 s, 1 s) | `coordination/lease.ts`, `leaderLoop.ts` |
| Expiry from observed change | A follower declares the lease expired when it has seen **no change** in holder, renew time and resource version for one lease duration on its own **monotonic** clock (the client-go rule). It never compares its wall clock with a timestamp written by another node | `LeaseObserver` in `lease.ts` |
| Epoch fencing | Taking leadership increments a per-source epoch stored in the Canonical Store. Every canonical write carries the epoch; a record written under an older epoch is rejected (`stale_epoch`), also when the writer is a frozen former leader that wakes up | `coordination/fencing.ts`, `storage/mongoRepository.ts` |
| Self-fencing | A leader that cannot renew within the renew deadline stops acting (its monotonic deadline passes) before another instance can take the lease, so the two intervals do not overlap even without the epoch | `leaderLoop.ts` |
| Durable checkpoints | The poll cursor or feed offset is committed after the effects, with a state version and the owner epoch. A new leader resumes from the checkpoint; effects are idempotent (record version = source offset), so a crash between write and checkpoint replays safely | `coordination/checkpoints.ts` |

### Time source and why it is safe under clock skew
Leadership timing depends only on monotonic clocks and on "did the Lease change", never on wall-clock agreement between nodes. Before this was
fixed, expiry compared an API-server `Date` header with the lease's `renewTime`; every k3s node runs an API server, so one drifted node clock made
instances disagree and leadership flapped (10 changes in 3 minutes at +45 s / -30 s). After the change the same test gives 0 changes.

### Timeout trade-off
A short lease detects a dead leader sooner but risks needless handovers when the network or the store is slow; a long lease is stable but leaves a gap.
Measured with 20 s: takeover 20 to 26 s after a real node power-off (requirement: at most 60 s), with the dead-node detection tuned to about 16 s.
The coastal source uses 8 s because of its 5 s alert deadline; a node loss there still leaves a gap of about one lease (see the evidence for the measured effect on alerts).

### Degraded store
While a data member is down, a write that must be confirmed by two copies times out. Coordination writes (lease epoch, checkpoint, inbox) would then stall the
failover. They therefore use `w:1` **only while the store is degraded** and `w:2` otherwise. The degraded state comes from the store health prober, and also
from any bookkeeping write that itself times out on its write concern (so a slow prober cannot stall a failover). Canonical data writes keep their own
`degraded` acknowledgement.

### Known limits
* Fencing is check-then-write with a compensating remove for a brand-new record: a stale writer's insert can be visible for a moment before it is removed. Per-record `fence_epoch` blocks updates atomically.
* The 3-instance vs 1-instance throughput ratio and 10,000 virtual users could not be demonstrated on this PC (about 100-150 req/s through the NodePort path saturates the VM CPUs); see the evidence.

## P3: parked messages, schema changes and field reports

### Schema policy (declared)
| Change in a PVMBG payload | Treatment |
|---|---|
| New optional field | **Accepted** automatically and kept under `attributes` |
| Renamed field, changed type, missing required field, unknown enum value | **Incompatible**: the message is kept whole, parked with reason, source and time, `retryable:false`, and not stored as an event |
| Rule change by Internal Ops (`POST /unprocessed/schema-rules`) | Aliases, numeric-string coercion and defaults are stored in the Canonical Store, in force on **every** replica after a few seconds, and survive restarts |
| Replay (`POST /unprocessed/replay`) | Parked messages are re-evaluated **in order per source and key**; what the new rules can read is recovered, the rest stays parked; replaying again recovers nothing more |

### Failure handling
* **Retryable** failures (store or broker temporarily unavailable) are kept as `retrying` with exponential backoff (1 s base, 30 s cap, +/-25 % jitter) up to 5 attempts, then parked.
* **Permanent** failures (schema, malformed JSON, invalid UTF-8, nesting deeper than 32, payload over 256 KiB) are parked at once with a reason. The raw bytes are kept unchanged: the message id is derived from the SHA-256 of the original bytes, which `p3-checks.sh` uses to prove the stored copy is identical.
* A malformed payload never crashes or restarts a pod and never blocks other sources.
* Access: only BNPB Ops can read or replay parked messages (403 for Media and Tim Lapangan).

### Field reports: delivery guarantee
`POST /field-reports` writes the report and an outbox entry in the Canonical Store, then answers **202**. A relay publishes from the outbox to the broker with an
idempotency key. Guarantee: **at least once to the broker, exactly once in the store** (the report id and idempotency key make a repeat a no-op; a different payload under the same key is a 409).
Proof (`p3-checks.sh`): with the broker down, 20 of 20 reports answered 202 in under 1 s; all aggregator pods were then killed; after recovery none was lost and none was stored twice.
Not covered: a slow-but-up downstream, and a crash exactly between the commit and the reply (the client retries with the same key and gets the same result).

### Broker
RabbitMQ runs as a 3-node cluster with quorum queues, one replica per node, so the loss of one node does not lose acknowledged messages.
