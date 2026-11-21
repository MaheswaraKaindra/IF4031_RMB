# Service-to-storage ownership matrix

| Service | Owns | Reaches storage via | Credential | Network path | If storage is down |
|---|---|---|---|---|---|
| aggregator | canonical store (`bnpb_canonical_store`) | MongoDB driver -> mongos (sharded) or mongo (dev) | `aggregator` user, readWrite on that DB only; `probe` user (read + clusterMonitor) for placement | NetworkPolicy: only `role=aggregator` may open 27017 to storage pods | Readiness fails (drains traffic), pollers keep cursors; reads answer partial/503 |
| client-api | nothing | aggregator `/internal/events`, `/internal/status` | JWT (clients) | allowed from `client-api` to aggregator:3000 only | 503 with correlation id; partial flag passes through |
| auth-service | refresh-token state (in memory, M1 debt) | none | RS256 private key | none to storage | n/a |
| consumers | nothing durable (M1 dedup in memory) | broker only | RabbitMQ user | rabbitmq:5672 only | broker outage -> reconnect loop |
| RabbitMQ | broker queues | n/a | RabbitMQ user | from aggregator and consumers only | publishers buffer (M1: in memory) |
| mocks | none | none | per-mock token | from aggregator (+ node CIDR for the Tester Agent) | n/a |

Enforced by `k8s/base/policy` and `k8s/store/policy.yaml`; checked by `scripts/k8s/verify-isolation.sh`.
