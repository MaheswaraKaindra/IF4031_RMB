# Deployment diagram (demo: 3 VMs)

Physical host → VM / Kubernetes node → pod → node-local disk. The logical architecture diagram in the report does not replace this one.
Placement source of truth: `k8s/store/layout.json` (store members per slot) and `scripts/k8s/label-nodes.sh` (slot → node).

```mermaid
flowchart TB
  subgraph HOST["Physical host: PC (32 GB RAM)"]
    direction TB
    subgraph N1["VM node-a · k3s server + worker · bnpb.io/store-slot=1"]
      direction TB
      S1["mongo-s1-a (shard-1 data)<br/>mongo-s3-b (shard-3 data)<br/>mongo-s2-arb (shard-2 arbiter)<br/>mongo-cfg-1 (config)"]
      D1[("local-path PV<br/>/var/lib/rancher/k3s/storage")]
      S1 --- D1
    end
    subgraph N2["VM node-b · k3s agent · bnpb.io/store-slot=2"]
      direction TB
      S2["mongo-s1-b (shard-1 data)<br/>mongo-s2-a (shard-2 data)<br/>mongo-s3-arb (shard-3 arbiter)<br/>mongo-cfg-2 (config)"]
      D2[("local-path PV")]
      S2 --- D2
    end
    subgraph N3["VM node-c · k3s agent · bnpb.io/store-slot=3"]
      direction TB
      S3["mongo-s2-b (shard-2 data)<br/>mongo-s3-a (shard-3 data)<br/>mongo-s1-arb (shard-1 arbiter)<br/>mongo-cfg-3 (config)"]
      D3[("local-path PV")]
      S3 --- D3
    end
    ST["Stateless pods, scheduled on any node<br/>(spread = kept on different nodes)<br/>client-api ×2 (spread) · auth-service ×2 (spread)<br/>mongos ×2 (spread) · aggregator ×1 (≥3 with P2)<br/>consumers ×3 · mock-bmkg · mock-pvmbg · sensor-pantai<br/>prometheus · grafana · jaeger"]
    RMQ["rabbitmq-0 (StatefulSet, 1 replica)"]
    DR[("local-path PV on its node")]
    RMQ --- DR
  end
  C(["Clients / Tester Agent"]) -->|"NodePort 30090 auth · 30080 client-api · 30000 Audit API"| ST
```

## Traffic paths (all inside namespace `sistem-informasi-kebencanaan-bnpb`)

| From | To (Service DNS : port) | Protocol | Allowed by |
|---|---|---|---|
| Clients | any node `:30090` → `auth-service:8090` (ClientIP affinity) | HTTP | NodePort |
| Clients | any node `:30080` → `client-api:8080` | HTTP + JWT RS256 | NodePort |
| Assistants / Tester | any node `:30000` → `aggregator-audit:3001` | HTTP + Bearer audit token | NodePort |
| client-api | `aggregator:3000` (`/internal/*`) | HTTP | NetworkPolicy: client-api only |
| aggregator | `mock-bmkg:8081`, `mock-pvmbg:8082`, `sensor-pantai:8080` | HTTP | NetworkPolicy |
| aggregator | `mongos:27017` | MongoDB wire, keyfile auth between members | NetworkPolicy: `role=aggregator` only |
| aggregator | `mongo-s*-*-0.<member>:27017` directly | MongoDB wire (probe user) | NetworkPolicy: placement probes, degraded scans |
| mongos | config RS `cfg` + shard RSs `s1`/`s2`/`s3` | MongoDB wire | store-ingress policy |
| aggregator, consumers | `rabbitmq:5672` | AMQP | NetworkPolicy |
| all services | `jaeger:4318` | OTLP/HTTP | allow-otlp-to-jaeger |
| prometheus | pod `/metrics`, kubelet cAdvisor | HTTP | allow-prometheus-scrape |

Cross-node traffic: every shard replicates between its two data members, which are always on two **different** VMs (oplog over
27017). Arbiters vote only. Pods reach each other through the k3s overlay network (flannel VXLAN); NodePorts work on every node.

## What a lost VM takes with it

- **Store:** one data member of two shards and one arbiter. Every shard keeps one readable data member, so reads stay complete.
  Writes to those shards are acknowledged `degraded` until re-sync. The disk is node-local, so a replacement starts empty and
  re-syncs (`scripts/k8s/p1-replace-node.sh`).
- **Stateless pods:** rescheduled after about 70 s (20 s eviction toleration in the demo overlay). Copies that exist twice keep serving.
- **Single copies:** the aggregator (until P2) and RabbitMQ (until P3). RabbitMQ is not recreated while its node is unreachable,
  because a StatefulSet never starts a second copy of a pod it cannot confirm is gone.
