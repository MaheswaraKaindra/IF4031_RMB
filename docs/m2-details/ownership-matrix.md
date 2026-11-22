# Service-to-storage ownership matrix

| Service | Owns | Reaches storage via | Credential | Network path | If storage is down |
|---|---|---|---|---|---|
| aggregator | canonical store (`bnpb_canonical_store`) | MongoDB driver -> mongos (sharded) or mongo (dev) | `aggregator` user, readWrite on that DB only; `probe` user (read + clusterMonitor) for placement | NetworkPolicy: only `role=aggregator` may open 27017 to storage pods | Readiness fails (drains traffic), pollers keep cursors; reads answer partial/503 |
| satellite stream processor (runs INSIDE the aggregator process, only on the SATELIT lease leader) | `satellite_feed_log` (raw frames by offset), `satellite_snapshots` (processor state), `satellite_late_detections`, its checkpoint and fence epoch, and the WILDFIRE records it writes through the repository | same `aggregator` user and path; feed log, snapshot and late store use the bookkeeping write concern (`w:2`, `w:1` while the store is degraded) | not a separate service: it shares the aggregator's NetworkPolicy and credentials | ingest keeps appending to the feed log while processing waits; processing resumes from the checkpoint |
| coastal pipeline (inside the aggregator, COASTAL lease leader) | `coastal_deliveries` (delivery ledger), the SENSOR_PANTAI records and its checkpoint | same `aggregator` user; ledger uses the bookkeeping write concern | shares the aggregator's policy; the sensor is reached on `sensor-pantai:8080` | critical alerts stay in the ledger and the relay delivers them when the store returns |
| client-api | nothing | aggregator `/internal/events`, `/internal/status` | JWT (clients) | allowed from `client-api` to aggregator:3000 only | 503 with correlation id; partial flag passes through |
| auth-service | refresh-token state (in memory, M1 debt) | none | RS256 private key | none to storage | n/a |
| consumers | nothing durable (M1 dedup in memory) | broker only | RabbitMQ user | rabbitmq:5672 only | broker outage -> reconnect loop |
| RabbitMQ | broker queues | n/a | RabbitMQ user | from aggregator and consumers only | publishers buffer (M1: in memory) |
| mocks | none | none | per-mock token | from aggregator (+ node CIDR for the Tester Agent) | n/a |

Enforced by `k8s/base/policy` and `k8s/store/policy.yaml`; checked by `scripts/m2/verify-isolation.sh`.
