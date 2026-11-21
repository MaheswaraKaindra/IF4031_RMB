#!/usr/bin/env bash
# P2 Verification Helper: leader lease, upstream non-duplicate polls, failover <=60s, scaling 3->5->2, rolling update.
set -euo pipefail

NS=sistem-informasi-kebencanaan-bnpb

echo "=== 1. Aggregator pod distribution across nodes (P2-K1) ==="
kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o wide

echo "=== 2. Current Kubernetes Leases (per-source ownership) ==="
kubectl -n "$NS" get leases

echo "=== 3. Active leader & epoch per Aggregator pod ==="
for pod in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}'); do
  echo -n "$pod: "
  kubectl -n "$NS" exec "$pod" -- wget -qO- http://127.0.0.1:3000/health | jq -c '{pod, leadership}'
done

echo "=== 4. Upstream poll distribution from mock logs (P2-K2) ==="
kubectl -n "$NS" logs deploy/mock-bmkg --tail=20 | grep 'upstream poll served' || true
kubectl -n "$NS" logs deploy/mock-pvmbg --tail=20 | grep 'upstream poll served' || true

echo "=== 5. Scaling & rolling update commands (run alongside k6 load-test/p2-scale.js) ==="
cat <<'EOF'
To test P2-K6 (3 -> 5 -> 2 during k6 >=10,000 VU / >=120s):
  kubectl -n sistem-informasi-kebencanaan-bnpb scale deploy/aggregator --replicas=5
  sleep 30
  kubectl -n sistem-informasi-kebencanaan-bnpb scale deploy/aggregator --replicas=2
  sleep 30
  kubectl -n sistem-informasi-kebencanaan-bnpb scale deploy/aggregator --replicas=3

To test P2-K8 (zero-downtime rolling update during load):
  kubectl -n sistem-informasi-kebencanaan-bnpb set env deploy/aggregator ROLLOUT_VERSION=v2
  kubectl -n sistem-informasi-kebencanaan-bnpb rollout status deploy/aggregator
EOF
