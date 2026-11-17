#!/usr/bin/env bash
# Publish the placement map (unit -> member -> real kubectl node name) as ConfigMap store-topology.
# The aggregator uses it for unavailable_units, /internal/audit/location and the per-node distribution report.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NS=${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

slots=$(kubectl get nodes -l bnpb.io/store-slot -o json \
  | jq -c '[.items[] | {key: .metadata.labels["bnpb.io/store-slot"], value: .metadata.name}] | from_entries')
[ "$(jq 'length' <<<"$slots")" = 3 ] || {
  echo "need nodes labelled bnpb.io/store-slot=1,2,3 (run scripts/k8s/label-nodes.sh <n1> <n2> <n3>); found: $slots" >&2; exit 1; }

topology=$(jq --argjson slots "$slots" --arg ns "$NS" '{
  units: [.shards[] | {name, members: [.members[] | {
    name, host: (.name + "-0." + .name + "." + $ns + ".svc.cluster.local"),
    node: $slots[(.slot | tostring)], arbiter}]}]}' "$ROOT/k8s/store/layout.json")

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$topology" > "$tmp"
kubectl -n "$NS" create configmap store-topology --from-file=topology.json="$tmp" --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
echo "store-topology: $(jq -c '[.units[] | {unit: .name, nodes: [.members[] | select(.arbiter|not) | .node]}]' <<<"$topology")"
